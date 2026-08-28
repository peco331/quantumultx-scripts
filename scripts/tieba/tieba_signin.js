/*
 * 百度贴吧全量签到（Quantumult X）
 *
 * 改动：
 * - 使用 c.tieba.baidu.com/c/f/forum/like 分页获取关注列表（每页 200 条）
 * - 合并 newmoindex 的结果并按 forum_id / 名称去重
 * - 不再限制 100 个，也没有批次之间的 setTimeout 等待
 * - 使用有限并发直接提交全部签到请求，避免并发时复用 POST body 的竞态
 *
 * 可选持久化配置：
 * - BDTB_Concurrency：同时发起的签到请求数，默认 8，范围 1–20
 * - BDTB_MaxPages：关注列表最多读取的页数，默认 50（每页 200 个）
 */

const $nobyda = nobyda();
const cookieVal = $nobyda.read('CookieTB');
const appVersion = '9.7.8.0';
const concurrency = clampNumber($nobyda.read('BDTB_Concurrency'), 8, 1, 20);
const maxPages = clampNumber($nobyda.read('BDTB_MaxPages'), 50, 1, 50);
const pageSize = 200;

const webHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Referer': 'https://tieba.baidu.com/index/tbwise/forum',
  'Cookie': cookieVal || '',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/16A366'
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
    const index = await request({
      url: 'https://tieba.baidu.com/mo/q/newmoindex',
      method: 'GET',
      headers: webHeaders
    });
    const indexBody = parseJson(index.body);
    if (!(indexBody && indexBody.no === 0 && indexBody.data && indexBody.data.tbs)) {
      throw new Error((indexBody && indexBody.error) || 'Cookie 可能已失效');
    }

    const forums = await getAllForums(indexBody.data.like_forum || []);
    if (forums.length === 0) throw new Error('未获取到任何关注贴吧');

    console.log(`关注贴吧总数: ${forums.length}，签到并发: ${concurrency}`);
    const results = await runWithConcurrency(forums, concurrency, forum => signForum(forum, indexBody.data.tbs));
    summarize(forums.length, results);
  } catch (error) {
    console.log(`贴吧签到异常: ${error.message || error}`);
    $nobyda.notify('贴吧签到', '签到失败', String(error.message || error));
  }
  $nobyda.done();
}

async function getAllForums(initialForums) {
  const forumMap = new Map();
  addForums(forumMap, initialForums);

  const bduss = (/(?:^|;\s*)BDUSS=([^;]+)/.exec(cookieVal) || [])[1] || '';
  if (!bduss) throw new Error('Cookie 中缺少 BDUSS，请重新抓取');

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
  params.sign = md5(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('') + 'tiebaclient!!!');

  const body = Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&');
  const response = await request({
    url: 'https://c.tieba.baidu.com/c/f/forum/like',
    method: 'POST',
    headers: {
      'User-Agent': `bdtb for Android ${appVersion}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieVal
    },
    body
  });
  const data = parseJson(response.body);
  if (!data || (data.error_code && String(data.error_code) !== '0')) {
    throw new Error(`第 ${pageNo} 页关注列表请求失败：${(data && (data.error_msg || data.error_code)) || '响应不是 JSON'}`);
  }
  return data;
}

function addForums(map, forums) {
  for (const forum of forums) {
    const name = String(forum.forum_name || forum.name || '').trim();
    if (!name) continue;
    const id = forum.forum_id || forum.id;
    const key = id ? `id:${id}` : `name:${name}`;
    if (!map.has(key)) map.set(key, { forum_name: name, is_sign: forum.is_sign });
  }
}

function extractAppForums(response) {
  if (!response || !response.forum_list) return [];
  if (Array.isArray(response.forum_list)) return response.forum_list;
  const groups = ['non_gconforum', 'gconforum'];
  return groups.reduce((all, key) => all.concat(Array.isArray(response.forum_list[key]) ? response.forum_list[key] : []), []);
}

function hasMore(response) {
  const value = response && (response.has_more !== undefined ? response.has_more : (response.page && response.page.has_more));
  return value === 1 || value === '1' || value === true;
}

async function signForum(forum, tbs) {
  if (String(forum.is_sign) === '1') {
    return { name: forum.forum_name, status: 'already', message: '已签到' };
  }
  const body = `tbs=${encodeURIComponent(tbs)}&kw=${encodeURIComponent(forum.forum_name)}&ie=utf-8`;
  try {
    const response = await request({
      url: 'https://tieba.baidu.com/sign/add',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookieVal,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 10_1_1 like Mac OS X; zh-CN) AppleWebKit/537.51.1 Mobile'
      },
      body
    });
    const data = parseJson(response.body);
    if (data && data.no === 0) {
      const uinfo = data.data && data.data.uinfo;
      return { name: forum.forum_name, status: 'success', message: uinfo ? `连续 ${uinfo.cont_sign_num} 天` : '签到成功' };
    }
    if (data && Number(data.no) === 1101) return { name: forum.forum_name, status: 'already', message: '已签到' };
    return { name: forum.forum_name, status: 'failed', message: (data && (data.error || data.no)) || '响应异常' };
  } catch (error) {
    return { name: forum.forum_name, status: 'failed', message: error.message || '网络错误' };
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

function summarize(total, results) {
  const success = results.filter(item => item.status === 'success').length;
  const already = results.filter(item => item.status === 'already').length;
  const failed = results.filter(item => item.status === 'failed');
  const lines = [
    `关注总数：${total}`,
    `新签到：${success}`,
    `已签到：${already}`,
    `失败：${failed.length}`
  ];
  if (failed.length) {
    lines.push('', '失败吧（最多列出 20 个）：');
    failed.slice(0, 20).forEach(item => lines.push(`【${item.name}】${item.message}`));
  }
  console.log(lines.join('\n'));
  $nobyda.notify('贴吧签到完成', `总计 ${total} 个｜成功 ${success}｜失败 ${failed.length}`, lines.join('\n'));
}

function request(options) {
  return $nobyda.request(options);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
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

/* 纯 JavaScript MD5；用于贴吧移动端关注列表接口的 sign 参数。 */
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
