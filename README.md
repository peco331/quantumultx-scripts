# quantumultx-scripts

贴吧任务和 Cookie 重写默认禁用。执行脚本及重写配置固定到不可变提交，地址见 `gallery/my_scripts.json`。

Cookie 捕获只接受 `https://tieba.baidu.com/mo/q/newmoindex`（可含查询参数），同时在脚本内核对地址。Cookie 保存在 QX 本地；获取成功后关闭捕获规则。账号原始响应和关注列表不写控制台日志。

配置已通过离线模拟测试；首次导入和请求命中需在自己的设备上核验。
