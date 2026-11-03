# webui-proxy - EvoFlow WebUI 局域网代理与可用性看护

三个零依赖 Node(18+) 脚本，守护 8382(webui-proxy) -> 127.0.0.1:8374(evoflow-gateway) 转发链。

| 文件 | 作用 | 调度 |
|---|---|---|
| proxy.js | 反向代理 8382->8374，HTTP/HTTPS 同端口嗅探分流，Basic-Auth 会话，XFF 覆写，自环截断 | 计划任务 EvoFlow WebUI Proxy（随登录常驻） |
| watchdog.mjs | 每分钟探活 8382；L1 拉起代理任务 / L2 重启代理进程 / L3 上游 503 只告警、绝不重启桌面端 | 计划任务 EvoFlow WebUI Watchdog（每 1 分钟） |
| gateway-sentinel.mjs | 并发锁死早期哨兵：扫 gateway 日志 Exceeded concurrency limit 频率，近 5 分钟 >=20 次且活跃则 ALERT。只读日志，不动任何进程 | 计划任务 EvoFlow Gateway Sentinel（每 1 分钟） |

## 2026-11-03 关键修复：proxy.js 连接泄漏导致 gateway 并发锁死（假死）

现象：桌面端运行数小时后 WebUI 全面 503（gateway 日志 Exceeded concurrency limit），重启桌面端即愈。11-01 起反复发生（11-03 单日 2238 次超限、两轮共约 95 分钟不可用）。

根因：req.pipe(proxyReq) 与 socket.pipe(upstream) 不传播 destroy。浏览器刷新/关页/断网后，代理到 gateway 的上游连接成为孤儿，持续占用 gateway limit_concurrency=384（Windows SelectorEventLoop 受 select FD 512 限制，无法调高）的并发槽位。槽位只进不出，顶满后一切请求 503。

修复（本目录 proxy.js 已含，两处）：
- HTTP 路径：req.on('aborted') / res.on('close') 时 proxyReq.destroy()
- WS/upgrade 路径：clientSocket.on('close') / upstream.on('close') 时双向销毁

验证判据：gateway 日志 Exceeded concurrency limit 频率趋零；gateway-sentinel-state.json 的 totalToday 不再持续增长。

## 部署（Windows 计划任务）

    schtasks /create /tn "EvoFlow WebUI Proxy" /tr "node <dir>proxy.js" /sc onlogon /rl highest /f
    schtasks /create /tn "EvoFlow WebUI Watchdog" /tr "node <dir>watchdog.mjs" /sc minute /mo 1 /ru SYSTEM /f
    schtasks /create /tn "EvoFlow Gateway Sentinel" /tr "node <dir>gateway-sentinel.mjs" /sc minute /mo 1 /ru SYSTEM /f

哨兵读 gateway 日志目录默认 C:Users<user>.evoflowlogs；SYSTEM 下 homedir 不对时用环境变量 EVOWEB_GATEWAY_LOG_DIR 显式指定。

## 运维速查

    Get-Content gateway-sentinel-state.json    # 哨兵状态: ok / concurrency-alert / no-log
    Get-Content gateway-sentinel.log -Tail 20  # ALERT/RECOVERY 明细
    Get-Content watchdog.log -Tail 20          # 探活与修复明细

状态文件：watchdog-state.json / gateway-sentinel-state.json；日志 >2MB 自动滚 .log.1。

## 可调环境变量（proxy.js）

- EVOWEB_MAX_UPSTREAM  上游并发自限，默认 300（gateway 硬上限 384，留余量保 /health）
- EVOWEB_IDLE_MS       SSE/WS 双向空闲超时毫秒，默认 600000（10 分钟无数据掐僵尸连接）
- EVOWEB_GATEWAY_LOG_DIR  哨兵 gateway 日志目录（SYSTEM 计划任务下必配）

