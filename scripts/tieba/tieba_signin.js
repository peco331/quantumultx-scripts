/*********************************
百度贴吧签到脚本

脚本说明：
自动签到所有关注的贴吧，支持串行/并行模式

使用说明：
1. 获取Cookie：打开百度贴吧App -> 点击"我的"
2. 添加定时任务：每天自动执行签到
3. 防风控：自动限制每次最多签到100个贴吧

配置项：
- BDTB_DailyBonus_Mode: 0自动/1串行/2并行
- BDTB_DailyBonus_notify: 每个通知包含的贴吧数量
- BDTB_MaxSign_Count: 每次最多签到数量（默认100）

脚本兼容：QuantumultX, Surge, Loon
更新日期：2025-12-03
原作者：@sazs34
优化：防风控、详细日志、限制签到数量
**********************************/

var $nobyda = nobyda();
var cookieVal = $nobyda.read("CookieTB");
var useParallel = 0;
var singleNotifyCount = 20;
var maxSignCount = 100; // 每次最多签到100个，防止触发验证码
var process = {
  total: 0,
  result: []
};

var url_fetch_sign = {
  url: "https://tieba.baidu.com/mo/q/newmoindex",
  headers: {
    "Content-Type": "application/octet-stream",
    Referer: "https://tieba.baidu.com/index/tbwise/forum",
    Cookie: cookieVal,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/16A366"
  }
};

var url_fetch_add = {
  url: "https://tieba.baidu.com/sign/add",
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookieVal,
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 10_1_1 like Mac OS X; zh-CN) AppleWebKit/537.51.1 (KHTML, like Gecko) Mobile/14B100 UCBrowser/10.7.5.650 Mobile"
  },
  body: ""
};

if ($nobyda.isRequest) {
  GetCookie()
} else {
  signTieBa()
}

function signTieBa() {
  useParallel = $nobyda.read("BDTB_DailyBonus_Mode") || useParallel;
  singleNotifyCount = $nobyda.read("BDTB_DailyBonus_notify") || singleNotifyCount;
  maxSignCount = $nobyda.read("BDTB_MaxSign_Count") || maxSignCount;
  
  if (!cookieVal) {
    $nobyda.notify("贴吧签到", "签到失败", "未获取到Cookie，请先获取Cookie");
    return $nobyda.done()
  }
  
  $nobyda.get(url_fetch_sign, function(error, response, data) {
    if (error) {
      $nobyda.notify("贴吧签到", "签到失败", "网络请求失败，请检查网络连接");
      $nobyda.done()
    } else {
      try {
        var body = JSON.parse(data);
        var isSuccessResponse = body && body.no == 0 && body.error == "success" && body.data && body.data.tbs;
        
        if (!isSuccessResponse) {
          $nobyda.notify("贴吧签到", "签到失败", (body && body.error) ? body.error : "Cookie可能已失效，请重新获取");
          return $nobyda.done()
        }
        
        if (!body.data.like_forum || body.data.like_forum.length === 0) {
          $nobyda.notify("贴吧签到", "签到失败", "未关注任何贴吧");
          return $nobyda.done()
        }
        
        // 限制签到数量，防止触发验证码
        var totalForums = body.data.like_forum.length;
        var forumsToSign = body.data.like_forum.slice(0, maxSignCount);
        process.total = forumsToSign.length;
        
        console.log(`关注贴吧总数: ${totalForums}, 本次签到: ${process.total}`);
        
        if (totalForums > maxSignCount) {
          console.log(`为防止触发验证码，只签到前${maxSignCount}个贴吧`);
        }
        
        // 选择签到模式
        if (useParallel == 1 || (useParallel == 0 && forumsToSign.length >= 30)) {
          console.log("使用串行模式签到");
          signBars(forumsToSign, body.data.tbs, 0);
        } else {
          console.log("使用并行模式签到");
          for (const bar of forumsToSign) {
            signBar(bar, body.data.tbs);
          }
        }
      } catch (e) {
        console.log("数据解析异常: " + e.message);
        $nobyda.notify("贴吧签到", "数据解析失败", "请检查Cookie是否有效");
        $nobyda.done()
      }
    }
  })
}

function signBar(bar, tbs) {
  if (bar.is_sign == 1) {
    process.result.push({
      bar: `${bar.forum_name}`,
      level: bar.user_level,
      exp: bar.user_exp,
      errorCode: 9999,
      errorMsg: "已签到"
    });
    checkIsAllProcessed();
  } else {
    url_fetch_add.body = `tbs=${tbs}&kw=${bar.forum_name}&ie=utf-8`;
    $nobyda.post(url_fetch_add, function(error, response, data) {
      if (error) {
        process.result.push({
          bar: bar.forum_name,
          errorCode: 999,
          errorMsg: '网络错误'
        });
        checkIsAllProcessed();
      } else {
        try {
          var addResult = JSON.parse(data);
          if (addResult.no == 0) {
            process.result.push({
              bar: bar.forum_name,
              errorCode: 0,
              errorMsg: `获得${addResult.data.uinfo.cont_sign_num}积分,第${addResult.data.uinfo.user_sign_rank}个签到`
            });
          } else {
            process.result.push({
              bar: bar.forum_name,
              errorCode: addResult.no,
              errorMsg: addResult.error
            });
          }
        } catch (e) {
          process.result.push({
            bar: bar.forum_name,
            errorCode: 998,
            errorMsg: '数据解析异常'
          });
        }
        checkIsAllProcessed();
      }
    })
  }
}

function signBars(bars, tbs, index) {
  if (index >= bars.length) {
    checkIsAllProcessed();
  } else {
    var bar = bars[index];
    if (bar.is_sign == 1) {
      process.result.push({
        bar: `${bar.forum_name}`,
        level: bar.user_level,
        exp: bar.user_exp,
        errorCode: 9999,
        errorMsg: "已签到"
      });
      signBars(bars, tbs, ++index);
    } else {
      url_fetch_add.body = `tbs=${tbs}&kw=${bar.forum_name}&ie=utf-8`;
      $nobyda.post(url_fetch_add, function(error, response, data) {
        if (error) {
          process.result.push({
            bar: bar.forum_name,
            errorCode: 999,
            errorMsg: '网络错误'
          });
          signBars(bars, tbs, ++index);
        } else {
          try {
            var addResult = JSON.parse(data);
            if (addResult.no == 0) {
              process.result.push({
                bar: bar.forum_name,
                errorCode: 0,
                errorMsg: `获得${addResult.data.uinfo.cont_sign_num}积分,第${addResult.data.uinfo.user_sign_rank}个签到`
              });
            } else {
              process.result.push({
                bar: bar.forum_name,
                errorCode: addResult.no,
                errorMsg: addResult.error
              });
            }
          } catch (e) {
            process.result.push({
              bar: bar.forum_name,
              errorCode: 998,
              errorMsg: '数据解析异常'
            });
          }
          signBars(bars, tbs, ++index)
        }
      })
    }
  }
}

function checkIsAllProcessed() {
  if (process.result.length != process.total) return;
  
  var batchCount = Math.ceil(process.total / singleNotifyCount);
  for (var i = 0; i < batchCount; i++) {
    var notify = "";
    var spliceArr = process.result.splice(0, singleNotifyCount);
    var notifySuccessCount = 0;
    for (const res of spliceArr) {
      if (res.errorCode == 0 || res.errorCode == 9999) {
        notifySuccessCount++;
      }
      if (res.errorCode == 9999) {
        notify += `【${res.bar}】已经签到，当前等级${res.level},经验${res.exp}\n`;
      } else {
        notify += `【${res.bar}】${res.errorCode==0?'签到成功':'签到失败'}，${res.errorCode==0?res.errorMsg:('原因：'+res.errorMsg)}\n`;
      }
    }
    
    // 如果有多批，显示批次信息
    var subtitle = batchCount > 1 ? 
      `第${i+1}批: 签到${spliceArr.length}个,成功${notifySuccessCount}个` : 
      `签到${spliceArr.length}个,成功${notifySuccessCount}个`;
    
    $nobyda.notify("贴吧签到", subtitle, notify);
  }
  $nobyda.done()
}

function GetCookie() {
  let headerCookie = $request.headers["Cookie"] || $request.headers["cookie"];
  if (headerCookie && headerCookie.includes('BDUSS=')) {
    if (!cookieVal) {
      $nobyda.notify("百度贴吧", "Cookie获取成功 🎉", "可以使用签到功能了");
    } else {
      console.log("Cookie已更新");
    }
    $nobyda.write(headerCookie, "CookieTB")
  } else {
    console.log("Cookie获取失败，BDUSS值缺失");
    $nobyda.notify("百度贴吧", "Cookie获取失败", "请确保打开的是贴吧App并点击'我的'");
  }
  return $nobyda.done();
}

function nobyda() {
  const isRequest = typeof $request != "undefined"
  const isSurge = typeof $httpClient != "undefined"
  const isQuanX = typeof $task != "undefined"
  const notify = (title, subtitle, message) => {
    if (isQuanX) $notify(title, subtitle, message)
    if (isSurge) $notification.post(title, subtitle, message)
  }
  const write = (value, key) => {
    if (isQuanX) return $prefs.setValueForKey(value, key)
    if (isSurge) return $persistentStore.write(value, key)
  }
  const read = (key) => {
    if (isQuanX) return $prefs.valueForKey(key)
    if (isSurge) return $persistentStore.read(key)
  }
  const adapterStatus = (response) => {
    if (response) {
      if (response.status) {
        response["statusCode"] = response.status
      } else if (response.statusCode) {
        response["status"] = response.statusCode
      }
    }
    return response
  }
  const get = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = {
        url: options
      }
      options["method"] = "GET"
      $task.fetch(options).then(response => {
        callback(null, adapterStatus(response), response.body)
      }, reason => callback(reason.error, null, null))
    }
    if (isSurge) $httpClient.get(options, (error, response, body) => {
      callback(error, adapterStatus(response), body)
    })
  }
  const post = (options, callback) => {
    if (isQuanX) {
      if (typeof options == "string") options = {
        url: options
      }
      options["method"] = "POST"
      $task.fetch(options).then(response => {
        callback(null, adapterStatus(response), response.body)
      }, reason => callback(reason.error, null, null))
    }
    if (isSurge) {
      $httpClient.post(options, (error, response, body) => {
        callback(error, adapterStatus(response), body)
      })
    }
  }
  const done = (value = {}) => {
    if (isQuanX) return $done(value)
    if (isSurge) isRequest ? $done(value) : $done()
  }
  return {
    isRequest,
    notify,
    write,
    read,
    get,
    post,
    done
  }
}
