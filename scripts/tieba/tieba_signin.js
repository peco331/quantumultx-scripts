/*
 * 百度贴吧全量签到（Quantumult X）
 *
 * 针对 “need vcode” 风控的改进：
 * - 默认串行签到（并发 1），请求间隔 1200ms 起并叠加随机抖动，降低触发风控的概率
 * - 每个吧先走客户端接口 c/c/forum/sign（带 fid 的 tiebaclient 签名），失败或命中验证码时退回网页接口 sign/add
 * - 命中 need vcode / 签得太快 等临时错误时，随机等待 6–14 秒后自动重试
 * - 连续多次 vcode 会熔断逐吧重试，避免持续刺激风控
 *
 * 结果核验（防止“接口说成功、App 里没签上”）：
 * - 通知里显示当前账号昵称，便于核对脚本 Cookie 与 App 登录的是否为同一账号
 * - 签完后从 newmoindex + c/f/forum/like 两个来源重新拉取服务器签到状态
 * - 对“服务器显示未签”或“接口自称成功但服务器无记录”的吧强制再签一遍复核
 *   （复核返回“已签过/成功”才算确认；不依赖任何列表字段，接口说已签也算服务器结论）
 * - 最终通知只报“已签/未确认”两种状态，未确认的逐个列出
 *
 * 可选持久化配置（$prefs，可用 BoxJS 或其他脚本写入）：
 * - BDTB_Concurrency：同时在途的签到请求数，默认 1，范围 1–10
 * - BDTB_RequestInterval：相邻签到请求的最小启动间隔（毫秒），默认 1200，范围 0–10000
 * - BDTB_MaxRetries：单个吧命中临时错误后的额外重试次数，默认 2，范围 0–5
 * - BDTB_VerifyRounds：签完后核验补签的轮数，默认 2，范围 0–5
 * - BDTB_VerifyDelay：每轮核验/补签前的等待毫秒数，默认 20000，范围 0–120000
 * - BDTB_TimeBudget：整次任务的时间预算（秒），默认 1200，范围 300–2400
 * - BDTB_MaxPages：关注列表最多读取的页数，默认 50（每页 200 个）
 */

const $nobyda = nobyda();
const cookieVal = $nobyda.read('CookieTB');
const appVersion = '9.7.8.0';
const concurrency = clampNumber($nobyda.read('BDTB_Concurrency'), 1, 1, 10);
const requestInterval = clampNumber($nobyda.read('BDTB_RequestInterval'), 1200, 0, 10000);
const maxRetries = clampNumber($nobyda.read('BDTB_MaxRetries'), 2, 0, 5);
const verifyRounds = clampNumber($nobyda.read('BDTB_VerifyRounds'), 2, 0, 5);
const verifyDelayMs = clampNumber($nobyda.read('BDTB_VerifyDelay'), 20000, 0, 120000);
const timeBudgetMs = clampNumber($nobyda.read('BDTB_TimeBudget'), 1200, 300, 2400) * 1000;
const maxPages = clampNumber($nobyda.read('BDTB_MaxPages'), 50, 1, 50);
const pageSize = 200;
const retryWaitMinMs = 6000;
const retryWaitMaxMs = 14000;
const circuitBreakLimit = 6;

const webHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Referer': 'https://tieba.baidu.com/index/tbwise/forum',
  'Cookie': cookieVal || '',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/16A366'
};

const appHeaders = {
  'User-Agent': `bdtb for Android ${appVersion}`,
  'Content-Type': 'application/x-www-form-urlencoded',
  'Cookie': cookieVal || ''
};

if ($nobyda.isRequest) {
  getCookie();
} else {
  run();
}

async function run() {
  if (!cookieVal) {
    $nobyda.notify('贴吧签到', '签到失败', '未获取到 Cookie，请先在贴吧 App 的“我的”页面抓取 Cookie');
    return $nobyda.done();
  }

  try {
    const bduss = (/(?:^|;\s*)BDUSS=([^;]+)/.exec(cookieVal) || [])[1] || '';
    if (!bduss) throw new Error('Cookie 中缺少 BDUSS，请重新抓取');

    let tbs = '';
    try {
      const index = await request({ url: `https://tieba.baidu.com/mo/q/newmoindex?_=${Date.now()}`, method: 'GET', headers: webHeaders });
      const indexBody = parseJson(index.body);
      if (indexBody && indexBody.no === 0 && indexBody.data) tbs = indexBody.data.tbs || '';
    } catch (_) { /* newmoindex 失败时走 dc/common/tbs 兜底 */ }

    if (!tbs) {
      console.log('newmoindex 未返回 tbs，改用 dc/common/tbs 获取');
      const tbsResp = await request({ url: 'https://tieba.baidu.com/dc/common/tbs', method: 'GET', headers: webHeaders });
      const tbsBody = parseJson(tbsResp.body);
      tbs = tbsBody && tbsBody.tbs;
      if (!tbs) throw new Error('获取 tbs 失败，Cookie 可能已失效');
    }

    const nickname = await getAccountNickname(bduss);
    console.log(`当前账号: ${nickname || '未知'}`);

    const forums = await getAllForums(bduss);
    if (forums.length === 0) throw new Error('未获取到任何关注贴吧');

    console.log(`关注贴吧总数: ${forums.length}，并发: ${concurrency}，间隔: ${requestInterval}ms，重试: ${maxRetries} 次/吧，核验补签: ${verifyRounds} 轮`);
    const state = { consecutiveRetryable: 0, circuitTripped: false };
    const deadline = Date.now() + timeBudgetMs;
    const results = new Array(forums.length);
    const indices = forums.map((_, i) => i);
    const firstPass = await runWithConcurrency(indices, concurrency, requestInterval, i => signForum(forums[i], tbs, bduss, state, deadline), deadline);
    firstPass.forEach((result, i) => { results[i] = result; });

    const reverified = new Set();
    let statusMap = await fetchSignStatus(bduss);
    if (statusMap && statusMap.size === 0) {
      console.log('两个来源都没有返回签到状态，改用签到接口二次确认');
      statusMap = null;
    }

    for (let round = 1; round <= verifyRounds; round++) {
      if (Date.now() + verifyDelayMs > deadline) {
        console.log('时间预算不足以继续核验补签，跳过');
        break;
      }
      const targets = [];
      forums.forEach((forum, i) => {
        const flag = statusMap ? statusMap.get(forum.forum_name) : undefined;
        const status = results[i] && results[i].status;
        const doubtful = statusMap
          ? flag === false || (flag === undefined && (status === 'success' || status === 'failed') && !reverified.has(i))
          : (status === 'success' || status === 'failed') && !reverified.has(i);
        if (doubtful) targets.push(i);
      });
      if (targets.length === 0) break;
      console.log(`核验第 ${round}/${verifyRounds} 轮：${targets.length} 个吧需要复核/补签，${verifyDelayMs / 1000}s 后开始`);
      await sleep(verifyDelayMs);
      const roundResults = await runWithConcurrency(targets, concurrency, requestInterval, i => forceSign(forums[i], tbs, bduss, deadline), deadline);
      roundResults.forEach((result, j) => {
        const i = targets[j];
        results[i] = result;
        if (result.status === 'success' || result.status === 'already') reverified.add(i);
      });
      statusMap = await fetchSignStatus(bduss);
      if (statusMap && statusMap.size === 0) statusMap = null;
    }

    summarize(forums, results, statusMap, nickname);
  } catch (error) {
    console.log(`贴吧签到异常: ${error.message || error}`);
    $nobyda.notify('贴吧签到', '签到失败', String(error.message || error));
  }
  $nobyda.done();
}

async function getAllForums(bduss) {
  const forumMap = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchForumPage(page, bduss);
    const pageForums = extractAppForums(response);
    addForums(forumMap, pageForums);
    console.log(`关注列表第 ${page} 页: ${pageForums.length} 个，累计 ${forumMap.size} 个`);

    if (!hasMore(response)) break;
  }
  return Array.from(forumMap.values());
}

async function fetchForumPage(pageNo, bduss) {
  const params = {
    BDUSS: bduss,
    _client_type: 4,
    _client_version: appVersion,
    _phone_imei: '000000000000000',
    model: 'HUAWEI P40',
    net_type: 1,
    page_no: pageNo,
    page_size: pageSize,
    stErrorNums: 1,
    stMethod: 1,
    stMode: 1,
    stSize: 320,
    stTime: 117,
    stTimesNum: 1,
    timestamp: Date.now()
  };
  params.sign = clientSign(params);

  const response = await request({
    url: 'https://c.tieba.baidu.com/c/f/forum/like',
    method: 'POST',
    headers: appHeaders,
    body: encodeBody(params)
  });
  const data = parseJson(response.body);
  if (!data || (data.error_code && String(data.error_code) !== '0')) {
    throw new Error(`第 ${pageNo} 页关注列表请求失败：${(data && (data.error_msg || data.error_code)) || '响应不是 JSON'}`);
  }
  return data;
}

async function getAccountNickname(bduss) {
  try {
    const params = {
      BDUSS: bduss,
      _client_type: '2',
      _client_version: appVersion,
      _phone_imei: '000000000000000',
      model: 'MI+5',
      net_type: '1',
      timestamp: Math.floor(Date.now() / 1000)
    };
    params.sign = clientSign(params);
    const response = await request({
      url: 'https://c.tieba.baidu.com/c/s/sync',
      method: 'POST',
      headers: appHeaders,
      body: encodeBody(params)
    });
    const data = parseJson(response.body);
    const user = data && (data.user || (data.data && data.data.user));
    if (user && (user.name_show || user.nickname || user.name)) {
      return String(user.name_show || user.nickname || user.name);
    }
    console.log(`账号信息响应（未解析到昵称）: ${String(response.body).slice(0, 200)}`);
    return '';
  } catch (error) {
    console.log(`获取账号信息失败: ${error.message || error}`);
    return '';
  }
}

/* 从 newmoindex + c/f/forum/like 两个来源收集服务器签到状态，key 为吧名。
   只有字段明确为 1/0 才计入；两个来源都拿不到的字段不计入（unknown）。 */
async function fetchSignStatus(bduss) {
  const map = new Map();
  let newIndexCount = 0;
  let likeCount = 0;
  let newIndexSample = null;
  let likeSample = null;

  try {
    const response = await request({ url: `https://tieba.baidu.com/mo/q/newmoindex?_=${Date.now()}`, method: 'GET', headers: webHeaders });
    const body = parseJson(response.body);
    const list = body && body.no === 0 && body.data && body.data.like_forum;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!newIndexSample) newIndexSample = item;
        newIndexCount++;
        mergeFlag(map, nameOf(item), readSignFlag(item));
      }
    }
  } catch (_) { /* 忽略，靠关注接口兜底 */ }

  try {
    for (let page = 1; page <= maxPages; page++) {
      const data = await fetchForumPage(page, bduss);
      const list = extractAppForums(data);
      for (const item of list) {
        if (!likeSample) likeSample = item;
        likeCount++;
        mergeFlag(map, nameOf(item), readSignFlag(item));
      }
      if (!hasMore(data)) break;
    }
  } catch (error) {
    console.log(`核验拉取关注列表中断: ${error.message || error}`);
  }

  console.log(`核验数据：newmoindex ${newIndexCount} 条，关注接口 ${likeCount} 条，合并 ${map.size} 条`);
  if (newIndexCount && !likeCount) console.log(`newmoindex 示例: ${JSON.stringify(newIndexSample).slice(0, 300)}`);
  if (likeCount) console.log(`关注接口示例: ${JSON.stringify(likeSample).slice(0, 300)}`);
  return map;
}

function nameOf(item) {
  return String((item && (item.forum_name || item.name)) || '').trim();
}

function readSignFlag(item) {
  if (!item) return undefined;
  const candidates = [
    item.is_sign, item.isSign, item.is_signed,
    item.user_info && item.user_info.is_sign,
    item.user_info && item.user_info.isSign
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') return String(value) === '1';
  }
  return undefined;
}

function mergeFlag(map, name, flag) {
  if (!name || flag === undefined) return;
  if (flag === false) map.set(name, false);
  else if (!map.has(name)) map.set(name, true);
}

function addForums(map, forums) {
  if (!Array.isArray(forums)) return;
  for (const forum of forums) {
    const name = nameOf(forum);
    if (!name) continue;
    const fid = forum.forum_id !== undefined && forum.forum_id !== null && forum.forum_id !== '' ? forum.forum_id : forum.id;
    const key = fid !== undefined && fid !== null && fid !== '' ? `id:${fid}` : `name:${name}`;
    if (!map.has(key)) {
      map.set(key, {
        forum_name: name,
        fid: fid !== undefined && fid !== null && fid !== '' ? String(fid) : '',
        is_sign: readSignFlag(forum)
      });
    }
  }
}

function extractAppForums(response) {
  if (!response || !response.forum_list) return [];
  if (Array.isArray(response.forum_list)) return response.forum_list;
  const groups = ['non_gconforum', 'non-gconforum', 'gconforum'];
  return groups.reduce((all, key) => all.concat(Array.isArray(response.forum_list[key]) ? response.forum_list[key] : []), []);
}

function hasMore(response) {
  const value = response && (response.has_more !== undefined ? response.has_more : (response.page && response.page.has_more));
  return value === 1 || value === '1' || value === true;
}

async function signForum(forum, tbs, bduss, state, deadline) {
  const name = forum.forum_name;
  if (forum.is_sign === true) {
    return { name, status: 'already', message: '已签到' };
  }

  let last = { name, status: 'failed', retryable: true, message: '未执行' };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      if (state.circuitTripped || Date.now() > deadline) break;
      const wait = randInt(retryWaitMinMs, retryWaitMaxMs);
      console.log(`【${name}】命中临时错误，${(wait / 1000).toFixed(1)}s 后第 ${attempt}/${maxRetries} 次重试`);
      await sleep(wait);
      if (Date.now() > deadline) break;
    }

    last = await attemptBothChannels(forum, tbs, bduss);
    if (last.status === 'success' || last.status === 'already') {
      state.consecutiveRetryable = 0;
      return last;
    }

    state.consecutiveRetryable++;
    if (!state.circuitTripped && state.consecutiveRetryable >= circuitBreakLimit) {
      state.circuitTripped = true;
      console.log('连续多次命中风控/验证码，熔断逐吧重试，仅保留核验补签');
    }
  }
  return last;
}

/* 核验轮强制复核：不管之前的结论如何，重新走一遍双通道。
   返回“成功/已签过”即为服务器确认；其他结果按失败处理。 */
async function forceSign(forum, tbs, bduss, deadline) {
  const name = forum.forum_name;
  let last = { name, status: 'failed', retryable: true, message: '未执行' };
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (attempt > 0) {
      if (Date.now() > deadline) break;
      const wait = randInt(retryWaitMinMs, retryWaitMaxMs);
      console.log(`【${name}】核验复核重试前等待 ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      if (Date.now() > deadline) break;
    }
    last = await attemptBothChannels(forum, tbs, bduss);
    if (last.status === 'success' || last.status === 'already') return last;
  }
  return last;
}

async function attemptBothChannels(forum, tbs, bduss) {
  const name = forum.forum_name;
  const clientResult = await signViaClient(forum, tbs, bduss);
  if (clientResult.status === 'success' || clientResult.status === 'already') {
    return { name, ...clientResult };
  }

  const webResult = await signViaWeb(forum, tbs);
  if (webResult.status === 'success' || webResult.status === 'already') {
    return { name, ...webResult };
  }

  return {
    name,
    status: 'failed',
    retryable: Boolean(clientResult.retryable || webResult.retryable),
    message: webResult.message || clientResult.message || '签到失败'
  };
}

async function signViaClient(forum, tbs, bduss) {
  if (!forum.fid) return { status: 'failed', retryable: true, message: '' };
  const params = {
    BDUSS: bduss,
    _client_type: '2',
    _client_version: appVersion,
    _phone_imei: '000000000000000',
    fid: forum.fid,
    kw: forum.forum_name,
    model: 'MI+5',
    net_type: '1',
    tbs: tbs,
    timestamp: Math.floor(Date.now() / 1000)
  };
  params.sign = clientSign(params);

  try {
    const response = await request({
      url: 'https://c.tieba.baidu.com/c/c/forum/sign',
      method: 'POST',
      headers: appHeaders,
      body: encodeBody(params)
    });
    const data = parseJson(response.body);
    if (!data) return { status: 'failed', retryable: true, message: '' };
    const code = String(data.error_code === undefined || data.error_code === null ? '' : data.error_code);
    if (code === '0') {
      const rank = data.user_info && data.user_info.user_sign_rank;
      return { status: 'success', message: rank ? `签到成功，今日第 ${rank} 个` : '签到成功' };
    }
    if (code === '160002') return { status: 'already', message: '已签到' };
    const message = `客户端接口: ${data.error_msg || code}`;
    if (isTransientSignError(code, data.error_msg)) return { status: 'failed', retryable: true, message };
    return { status: 'failed', retryable: false, message };
  } catch (_) {
    return { status: 'failed', retryable: true, message: '' };
  }
}

async function signViaWeb(forum, tbs) {
  const body = `tbs=${encodeURIComponent(tbs)}&kw=${encodeURIComponent(forum.forum_name)}&ie=utf-8`;
  try {
    const response = await request({
      url: 'https://tieba.baidu.com/sign/add',
      method: 'POST',
      headers: webHeaders,
      body
    });
    const data = parseJson(response.body);
    if (!data) return { status: 'failed', retryable: true, message: '' };
    if (Number(data.no) === 0) {
      const uinfo = data.data && data.data.uinfo;
      return { status: 'success', message: uinfo && uinfo.cont_sign_num ? `连续签到 ${uinfo.cont_sign_num} 天` : '签到成功' };
    }
    if (Number(data.no) === 1101) return { status: 'already', message: '已签到' };
    return { status: 'failed', retryable: isTransientSignError(data.no, data.error), message: String(data.error || data.no) };
  } catch (_) {
    return { status: 'failed', retryable: true, message: '' };
  }
}

function isTransientSignError(code, message) {
  const no = Number(code);
  return no === 1102 || no === 2150040 || no === 340006 || /vcode|验证码|签得太快/i.test(String(message || ''));
}

function clientSign(params) {
  return md5(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('') + 'tiebaclient!!!').toUpperCase();
}

function encodeBody(params) {
  return Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
}

async function runWithConcurrency(items, limit, interval, worker, deadline) {
  const results = new Array(items.length);
  let next = 0;
  let nextStartAt = 0;
  async function consume() {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      if (deadline && Date.now() > deadline) {
        results[current] = { status: 'skipped', message: '时间预算用尽，本轮跳过' };
        continue;
      }
      const now = Date.now();
      const wait = Math.max(0, nextStartAt - now);
      nextStartAt = Math.max(nextStartAt, now) + (interval > 0 ? Math.round(interval * (0.7 + Math.random() * 0.6)) : 0);
      if (wait) await sleep(wait);
      results[current] = await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function summarize(forums, results, statusMap, nickname) {
  const lines = [`账号：${nickname || '未知（请核对是否与 App 登录账号一致）'}`, `关注总数：${forums.length}`];
  const problems = [];
  let signed = 0;

  forums.forEach((forum, i) => {
    const serverFlag = statusMap ? statusMap.get(forum.forum_name) : undefined;
    const attempt = results[i];
    const attemptOk = attempt && (attempt.status === 'success' || attempt.status === 'already');
    if (serverFlag === true || attemptOk) {
      signed++;
    } else {
      const reason = attempt && attempt.message ? attempt.message
        : serverFlag === false ? '服务器显示未签'
        : '未确认';
      problems.push({ name: forum.forum_name, message: reason });
    }
  });

  const source = statusMap
    ? `（核验数据 ${statusMap.size} 条）`
    : '（服务器状态列表不可用，已签结果来自签到接口复核）';
  lines.push(`已签：${signed}`, `未确认：${problems.length}`, source);
  if (problems.length) {
    lines.push('', '以下吧未确认签到成功：');
    problems.forEach(item => lines.push(`【${item.name}】${item.message}`));
  }

  const subtitle = `总计 ${forums.length}｜已签 ${signed}｜未确认 ${problems.length}`;
  console.log(lines.join('\n'));
  $nobyda.notify('贴吧签到完成', subtitle, lines.join('\n'));
}

function request(options) {
  return $nobyda.request(options);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function clampNumber(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

function getCookie() {
  const headerCookie = $request.headers.Cookie || $request.headers.cookie;
  if (headerCookie && headerCookie.includes('BDUSS=')) {
    $nobyda.write(headerCookie, 'CookieTB');
    $nobyda.notify('百度贴吧', 'Cookie 获取成功', '可以使用全量签到功能');
  } else {
    $nobyda.notify('百度贴吧', 'Cookie 获取失败', '请确保抓取的是贴吧 App 请求且包含 BDUSS');
  }
  $nobyda.done();
}

function nobyda() {
  const isRequest = typeof $request !== 'undefined';
  const isQuanX = typeof $task !== 'undefined';
  const isSurge = typeof $httpClient !== 'undefined';
  return {
    isRequest,
    read: key => isQuanX ? $prefs.valueForKey(key) : $persistentStore.read(key),
    write: (value, key) => isQuanX ? $prefs.setValueForKey(value, key) : $persistentStore.write(value, key),
    notify: (title, subtitle, message) => isQuanX ? $notify(title, subtitle, message) : $notification.post(title, subtitle, message),
    request: options => new Promise((resolve, reject) => {
      if (isQuanX) {
        $task.fetch(options).then(response => resolve({ status: response.statusCode || response.status, body: response.body }), reason => reject(new Error(reason && (reason.error || reason.message) || '网络请求失败')));
      } else if (isSurge) {
        $httpClient[options.method.toLowerCase()](options, (error, response, body) => error ? reject(new Error(error)) : resolve({ status: response.statusCode || response.status, body }));
      } else {
        reject(new Error('不支持的脚本环境'));
      }
    }),
    done: value => $done(value || {})
  };
}

/* 纯 JavaScript MD5；用于贴吧移动端接口的 sign 参数。 */
function md5(input) {
  const bytes = unescape(encodeURIComponent(input));
  const words = [];
  for (let i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] || 0) | (bytes.charCodeAt(i) << ((i % 4) * 8));
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | (0x80 << (bitLength % 32));
  words[(((bitLength + 64) >>> 9) << 4) + 14] = bitLength;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    a = ff(a, b, c, d, words[i], 7, -680876936); d = ff(d, a, b, c, words[i + 1], 12, -389564586); c = ff(c, d, a, b, words[i + 2], 17, 606105819); b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897); d = ff(d, a, b, c, words[i + 5], 12, 1200080426); c = ff(c, d, a, b, words[i + 6], 17, -1473231341); b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416); d = ff(d, a, b, c, words[i + 9], 12, -1958414417); c = ff(c, d, a, b, words[i + 10], 17, -42063); b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682); d = ff(d, a, b, c, words[i + 13], 12, -40341101); c = ff(c, d, a, b, words[i + 14], 17, -1502002290); b = ff(b, c, d, a, words[i + 15], 22, 1236535329);
    a = gg(a, b, c, d, words[i + 1], 5, -165796510); d = gg(d, a, b, c, words[i + 6], 9, -1069501632); c = gg(c, d, a, b, words[i + 11], 14, 643717713); b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691); d = gg(d, a, b, c, words[i + 10], 9, 38016083); c = gg(c, d, a, b, words[i + 15], 14, -660478335); b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438); d = gg(d, a, b, c, words[i + 14], 9, -1019803690); c = gg(c, d, a, b, words[i + 3], 14, -187363961); b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467); d = gg(d, a, b, c, words[i + 2], 9, -51403784); c = gg(c, d, a, b, words[i + 7], 14, 1735328473); b = gg(b, c, d, a, words[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, words[i + 5], 4, -378558); d = hh(d, a, b, c, words[i + 8], 11, -2022574463); c = hh(c, d, a, b, words[i + 11], 16, 1839030562); b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060); d = hh(d, a, b, c, words[i + 4], 11, 1272893353); c = hh(c, d, a, b, words[i + 7], 16, -155497632); b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174); d = hh(d, a, b, c, words[i], 11, -358537222); c = hh(c, d, a, b, words[i + 3], 16, -722521979); b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487); d = hh(d, a, b, c, words[i + 12], 11, -421815835); c = hh(c, d, a, b, words[i + 15], 16, 530742520); b = hh(b, c, d, a, words[i + 2], 23, -995338651);
    a = ii(a, b, c, d, words[i], 6, -198630844); d = ii(d, a, b, c, words[i + 7], 10, 1126891415); c = ii(c, d, a, b, words[i + 14], 15, -1416354905); b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571); d = ii(d, a, b, c, words[i + 3], 10, -1894986606); c = ii(c, d, a, b, words[i + 10], 15, -1051523); b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359); d = ii(d, a, b, c, words[i + 15], 10, -30611744); c = ii(c, d, a, b, words[i + 6], 15, -1560198380); b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070); d = ii(d, a, b, c, words[i + 11], 10, -1120210379); c = ii(c, d, a, b, words[i + 2], 15, 718787259); b = ii(b, c, d, a, words[i + 9], 21, -343485551);
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd);
  }
  return [a, b, c, d].map(word => ('00000000' + (word >>> 0).toString(16)).slice(-8).match(/../g).reverse().join('')).join('');
}

function add(x, y) { return (x + y) & 0xffffffff; }
function rotate(x, n) { return (x << n) | (x >>> (32 - n)); }
function cmn(q, a, b, x, s, t) { return add(rotate(add(add(a, q), add(x || 0, t)), s), b); }
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
