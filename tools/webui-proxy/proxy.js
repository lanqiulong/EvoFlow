/**
 * EvoFlow WebUI 局域网反向代理（L7）
 *
 * 为什么需要它：
 *   桌面端把 Gateway 固定启动为 --host 127.0.0.1（官方设计，见
 *   evopanel/src-tauri/src/commands/backend.rs）。而 WebUI 的 JWT 登录门按
 *   客户端 IP 判定是否放行（evoflow/webui/middleware.py + auth.py:
 *   is_local_request 只认 127.0.0.1/::1）。
 *   四层端口转发（netsh portproxy）会把所有局域网请求的源地址改写成
 *   127.0.0.1，导致远程访问绕过登录。
 *
 *   本代理监听局域网地址，转发到回环 Gateway，并**覆写** X-Forwarded-For 为
 *   真实客户端 IP。Gateway 启用了 uvicorn proxy_headers，会据此还原客户端
 *   地址，于是：
 *     - 局域网访问 → 非本机 IP → 必须登录（JWT）
 *     - 桌面端访问 → 仍是 127.0.0.1 → 不受影响
 *   覆写（而非追加）可防止外部客户端自带 XFF 伪装成 127.0.0.1 绕过鉴权。
 *
 * 2026-11-01 修复（远程"能打开页面但功能不可用 / 时好时坏"）：
 *   1) 监听地址改为 0.0.0.0。原先绑死 DHCP 分配的 192.168.9.193，一旦租约
 *      续期换了 IP，bind 直接 EADDRNOTAVAIL → 进程退出 → 计划任务无限重启，
 *      表现为"昨天还能访问今天彻底不通"。
 *   2) 新增 Cookie 会话。浏览器的 new WebSocket() **不能**携带 Authorization
 *      头，只过 Basic 的话远程 WS 一律 401，实时功能（会话流、看板、语音）
 *      全废。现在 Basic 认证成功即下发签名 Cookie，WS 握手浏览器会自动带上。
 *   3) 落盘访问日志 proxy.log，便于远程排障。
 *
 * 用法：node proxy.js [--listen 0.0.0.0] [--port 8382] [--target 127.0.0.1:8382]
 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const https = require('https');

function parseArgs(argv) {
  const out = { listen: '0.0.0.0', port: 8382, target: '127.0.0.1:8374', noAuth: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--listen' && argv[i + 1]) out.listen = argv[++i];
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]) || 8382;
    else if (a === '--target' && argv[i + 1]) out.target = argv[++i];
    else if (a === '--no-auth') out.noAuth = true;
  }
  if (out.listen === 'auto' || out.listen === 'all' || out.listen === 'lan') out.listen = '0.0.0.0';
  return out;
}

const cfg = parseArgs(process.argv.slice(2));
const [tHost, tPort] = cfg.target.split(':');
const GATEWAY_PORT = 8374; // 【BUG修复】桌面端 sidecar 网关真实端口
let TARGET_PORT = Number(tPort) || GATEWAY_PORT;
// 【BUG修复】自环保护：target 与 listen 同端口时，每次转发都会回到本代理自身，
// 形成无界递归，句柄/动态端口耗尽后整站连接超时（本次故障的直接原因）。
if (TARGET_PORT === Number(cfg.port)) {
  TARGET_PORT = GATEWAY_PORT;
  console.error("[evoflow-webui-proxy] 配置自环 target=" + cfg.target + " == listen=" + cfg.port + "，已自动纠偏为 127.0.0.1:" + GATEWAY_PORT);
}

/* ---------------------------------------------------------------------------
 * 访问日志（远程排障用；写失败绝不影响转发）
 * ------------------------------------------------------------------------- */
const LOG_FILE = path.join(__dirname, 'proxy.log');
const LOG_MAX = 4 * 1024 * 1024;
function log(msg) {
  try {
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.writeFileSync(LOG_FILE, '');
    } catch (e) { /* 轮询失败忽略 */ }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch (e) { /* 只读盘等场景 */ }
  console.log(msg);
}

/* ---------------------------------------------------------------------------
 * 认证门（必需）
 * 桌面 stdio 模式下 Gateway 未装载 WebUI JWT 中间件
 * （backend/app/gateway/gateway_shell.py: install_pre_start_middleware 走
 *  _desktop_stdio_mode() 分支直接跳过，且 Starlette 不允许启动后再 add_middleware），
 * 因此远程请求在 Gateway 侧**没有任何鉴权**。本代理是唯一的门，故默认强制开启。
 * 凭据存 creds.json（首次运行自动生成强随机口令并打印一次）。
 * ------------------------------------------------------------------------- */
const CREDS_FILE = path.join(__dirname, 'creds.json');
const OPEN_PATHS = new Set(['/health', '/health/liveness', '/health/ready']);
const COOKIE_NAME = 'evoproxy_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function saveCreds(j) {
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
    return true;
  } catch (e) {
    log(`[evoflow-webui-proxy] 无法写 creds.json: ${e && e.message}`);
    return false;
  }
}

function loadCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (j && j.username && j.password) {
      if (!j.secret) { j.secret = crypto.randomBytes(32).toString('hex'); saveCreds(j); }
      return j;
    }
  } catch (e) { /* 首次运行 */ }
  const user = process.env.EVOWEB_USER || 'lzadmin';
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789#%*+-';
  let pass = '';
  const buf = crypto.randomBytes(20);
  for (const x of buf) pass += alpha[x % alpha.length];
  const j = {
    username: user,
    password: pass,
    secret: crypto.randomBytes(32).toString('hex'),
    created_at: new Date().toISOString(),
    note: '与 EvoFlow WebUI 账号保持一致，避免两套口令',
  };
  saveCreds(j);
  return j;
}

const CREDS = cfg.noAuth ? null : loadCreds();

function sign(payload) {
  return crypto.createHmac('sha256', CREDS.secret).update(String(payload)).digest('hex');
}
function makeToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${sign(`${CREDS.username}.${exp}`)}`;
}
function checkToken(tok) {
  if (!tok) return false;
  const i = tok.indexOf('.');
  if (i < 0) return false;
  const exp = tok.slice(0, i);
  const sig = tok.slice(i + 1);
  if (!timingSafeEq(sig, sign(`${CREDS.username}.${exp}`))) return false;
  return Number(exp) > Date.now();
}
function cookieAuth(req) {
  const h = req.headers.cookie || '';
  for (const part of h.split(/;\s*/)) {
    if (part.indexOf(`${COOKIE_NAME}=`) === 0) {
      let v = part.slice(COOKIE_NAME.length + 1);
      try { v = decodeURIComponent(v); } catch (e) { /* 原样比对 */ }
      return checkToken(v);
    }
  }
  return false;
}
function basicAuth(req) {
  const h = req.headers['proxy-authorization'] || req.headers.authorization || '';
  if (!/^Basic\s+/i.test(h)) return false;
  let decoded = '';
  try { decoded = Buffer.from(h.replace(/^\S+\s+/i, ''), 'base64').toString('utf8'); }
  catch (e) { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return timingSafeEq(decoded.slice(0, i), CREDS.username) &&
         timingSafeEq(decoded.slice(i + 1), CREDS.password);
}
function sessionCookie() {
  return `${COOKIE_NAME}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clientIp(socket) {
  return ((socket && socket.remoteAddress) || '').replace(/^::ffff:/i, '');
}

function rejectUnauthorized(res) {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Basic realm="EvoFlow WebUI", charset="UTF-8"',
    'cache-control': 'no-store',
  });
  res.end('Authentication required (EvoFlow WebUI proxy)\n');
}

// 【修复A】上游防护：并发上限 + 僵尸连接空闲超时。
// gateway limit_concurrency=384（Windows select FD 512，调不高）。代理自限 MAX_UPSTREAM，
// 超限直接 503+Retry-After（不占上游槽位），保证 /health 等关键请求永远有槽；
// SSE/WS 双向无数据超过 IDLE_MS 视为僵尸连接掐断（半开 TCP 收不到 close 事件，只能靠应用层超时清）。
const MAX_UPSTREAM = Number(process.env.EVOWEB_MAX_UPSTREAM || 300);
const IDLE_MS = Number(process.env.EVOWEB_IDLE_MS || 600000);
let activeUpstream = 0;

function handleRequest(req, res) {
  const ip = clientIp(req.socket);
  // 【BUG修复】自环兜底：入站请求已带本代理标记，说明它在转发链路里又回到自己，
  // 立即 508 截断，防止无限递归（即使端口配置被改回自环也不会拖垮进程）。
  if (req.headers['x-evoproxy-hop']) {
    res.writeHead(508, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('proxy self-loop detected\n');
    return;
  }
  let grantCookie = false;

  if (CREDS && !OPEN_PATHS.has(req.url.split('?')[0])) {
    const viaCookie = cookieAuth(req);
    const viaBasic = viaCookie ? false : basicAuth(req);
    if (!viaCookie && !viaBasic) {
      log(`DENY  ${req.method} ${req.url} from ${ip}`);
      return rejectUnauthorized(res);
    }
    if (viaBasic) grantCookie = true; // 让后续 WS 握手能复用会话
  }

  // 覆写 XFF / X-Real-IP：丢弃客户端自带的，防伪造
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-real-ip'];
  req.headers['x-forwarded-for'] = ip;
  req.headers['x-real-ip'] = ip;
  // 不把代理凭据透传给 Gateway
  delete req.headers['proxy-authorization'];
  req.headers['x-evoproxy-hop'] = '1'; // 【BUG修复】转发链路标记，配合自环兜底

  const opts = {
    host: tHost || '127.0.0.1',
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: req.headers,
  };

  // 【修复A】并发上限：超限先在代理层挡下，不去挤 gateway 槽位
  if (activeUpstream >= MAX_UPSTREAM) {
    log('THROTTLE ' + req.method + ' ' + req.url + ' from ' + ip + ' active=' + activeUpstream);
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
    res.end("proxy upstream concurrency limit reached" + String.fromCharCode(10));
    req.resume(); // 丢弃请求体，防客户端阻塞
    return;
  }
  activeUpstream++;
  let counted = true;
  const release = () => { if (counted) { counted = false; activeUpstream--; } };
  // 【修复A】空闲定时器：任一方向有数据就重置；超时=僵尸连接，双向掐断
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('IDLE-KILL ' + req.method + ' ' + req.url + ' from ' + ip + ' (no data ' + Math.round(IDLE_MS / 1000) + 's)');
      try { proxyReq.destroy(); } catch (e) {}
      try { res.destroy(); } catch (e) {}
    }, IDLE_MS);
  };
  const disarmIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  armIdle();
  const proxyReq = http.request(opts, (proxyRes) => {
    const headers = Object.assign({}, proxyRes.headers);
    if (grantCookie) headers['set-cookie'] = [sessionCookie()];
    res.writeHead(proxyRes.statusCode || 502, headers);
    proxyRes.pipe(res);
    proxyRes.on('data', armIdle); // 【修复A】流式响应有数据就重置空闲计时
    log(`OK    ${req.method} ${req.url} from ${ip} -> ${proxyRes.statusCode}`);
  });

  proxyReq.on('error', (err) => {
    release(); disarmIdle(); // 【修复A】释放并发计数与定时器
    log(`UPSTREAM-ERR ${req.method} ${req.url} from ${ip}: ${err && err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ detail: 'evoflow gateway unavailable', error: String(err && err.message) }));
  });

  // 【BUG修复】客户端断开(刷新/关页/断网)时立即掐断上游请求：
  // req.pipe(proxyReq) 不传播 destroy，浏览器断开后 proxy→gateway 的上游连接
  // 会变成孤儿，持续占用 gateway limit_concurrency=384 的并发槽位；
  // 累积顶满后 gateway 对一切请求返回 503（两次假死的直接推手）。
  const abortUp = () => { try { proxyReq.destroy(); } catch (e) {} };
  req.on('aborted', abortUp);
  res.on('close', () => { abortUp(); release(); disarmIdle(); }); // 【修复A】完成/断开都释放计数与定时器
  // 关闭 Nagle，利于 SSE 流式响应及时下发
  if (req.socket) req.socket.setNoDelay(true);
  req.on('data', armIdle); // 【修复A】上传流也算活跃
  req.pipe(proxyReq);
}

// WebSocket / 其它 CONNECT 升级：原样管道转发，并同样注入 XFF
function handleUpgrade(req, clientSocket, head, viaTls) {
  const ip = clientIp(clientSocket);
  if (CREDS) {
    const viaCookie = cookieAuth(req);
    const viaBasic = viaCookie ? false : basicAuth(req);
    if (!viaCookie && !viaBasic) {
      log(`DENY-WS ${req.url} from ${ip}`);
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\n' +
        'www-authenticate: Basic realm="EvoFlow WebUI"\r\n' +
        'content-length: 0\r\nconnection: close\r\n\r\n');
      try { clientSocket.destroy(); } catch (e) {}
      return;
    }
  }

  const headers = Object.assign({}, req.headers);
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  delete headers['proxy-authorization'];
  headers['x-forwarded-for'] = ip;
  headers['x-real-ip'] = ip;
  // 浏览器 WS 无法带 Authorization，顺手在 101 里补发会话 Cookie
  if (CREDS && !cookieAuth(req)) headers['set-cookie'] = sessionCookie();

  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) v.forEach((x) => lines.push(`${k}: ${x}`));
    else if (v !== undefined) lines.push(`${k}: ${v}`);
  }
  const banner = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1');

  // 【修复A】WS 同样占 gateway 槽位：计数 + 超限拒绝 + 双向空闲超时
  if (activeUpstream >= MAX_UPSTREAM) {
    log('THROTTLE-WS ' + req.url + ' from ' + ip + ' active=' + activeUpstream);
    clientSocket.write(["HTTP/1.1 503 Service Unavailable","retry-after: 2","content-length: 0","connection: close","",""].join(String.fromCharCode(13,10)));
    try { clientSocket.destroy(); } catch (e) {}
    return;
  }
  activeUpstream++;
  let wsCounted = true;
  const wsRelease = () => { if (wsCounted) { wsCounted = false; activeUpstream--; } };
  let wsIdle = null;
  const armWsIdle = () => {
    if (wsIdle) clearTimeout(wsIdle);
    wsIdle = setTimeout(() => {
      log('IDLE-KILL-WS ' + req.url + ' from ' + ip + ' (no data ' + Math.round(IDLE_MS / 1000) + 's)');
      bye();
    }, IDLE_MS);
  };
  armWsIdle();
  const upstream = net.connect(TARGET_PORT, tHost || '127.0.0.1', () => {
    upstream.write(banner);
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const bye = () => {
    if (wsIdle) { clearTimeout(wsIdle); wsIdle = null; } wsRelease(); // 【修复A】释放 WS 计数与定时器
    try { upstream.destroy(); } catch (e) {}
    try { clientSocket.destroy(); } catch (e) {}
  };
  upstream.on('error', (e) => { log(`UPSTREAM-WS-ERR ${req.url} from ${ip}: ${e && e.message}`); bye(); });
  clientSocket.on('error', bye);
  // 【BUG修复】pipe 不传播 destroy：WS 客户端断开时上游也要关，否则 gateway WS 槽位泄漏
  clientSocket.on('close', bye);
  upstream.on('close', bye);
  upstream.on('data', armWsIdle); clientSocket.on('data', armWsIdle); // 【修复A】双向有数据就重置
  upstream.setTimeout(0);
  clientSocket.setTimeout(0);
  log(`WS    ${req.url} from ${ip}`);
}

/* ---------------------------------------------------------------------------
 * 双协议：同端口同时接受 HTTP 与 HTTPS（TLS 首字节嗅探）
 *
 * 为什么要这么做：桌面端/浏览器偶尔会用 https://<ip>:8382 访问（浏览器自动
 * 升级、或书签沿用旧地址）。之前代理只 createServer(http)，TLS 客户端会直接
 * 收到明文响应 → ERR_SSL_WRONG_VERSION_NUMBER，页面表现为“打不开/加载失败”。
 *
 * 证书：D:/EvoFlow/webui-proxy/tls/evoflow-lan.{crt,key}.pem（自签名，SAN 含
 * 192.168.9.193 / 127.0.0.1 / localhost，有效期 10 年）。浏览器首次访问需
 * 手动信任一次；不影响 HTTP 访问。
 * ------------------------------------------------------------------------- */
const TLS_DIR = path.join(__dirname, 'tls');
const TLS_CERT = path.join(TLS_DIR, 'evoflow-lan.crt.pem');
const TLS_KEY = path.join(TLS_DIR, 'evoflow-lan.key.pem');
let tlsOptions = null;
try {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    tlsOptions = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
  }
} catch (e) {
  log(`[evoflow-webui-proxy] TLS 证书读取失败，HTTPS 不可用: ${e && e.message}`);
  tlsOptions = null;
}

const httpServer = http.createServer(handleRequest);
httpServer.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, false));

let httpsServer = null;
if (tlsOptions) {
  httpsServer = https.createServer(tlsOptions, handleRequest);
  httpsServer.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, true));
}

/* 前置分流器：根据首个字节判断是 TLS ClientHello(0x16) 还是明文 HTTP。
 * 注意：必须让 https/http server 自己接管 socket（不要手工 new tls.TLSSocket），
 * 手工包装会吞掉 ClientHello 导致浏览器握手超时（已实测）。 */
const frontDoor = net.createServer((rawSocket) => {
  rawSocket.on('error', () => { try { rawSocket.destroy(); } catch (e) {} });
  rawSocket.once('data', (chunk) => {
    rawSocket.pause();
    rawSocket.unshift(chunk);
    if (chunk[0] === 0x16 && httpsServer) {
      httpsServer.emit('connection', rawSocket);
    } else {
      httpServer.emit('connection', rawSocket);
    }
    setImmediate(() => { try { rawSocket.resume(); } catch (e) {} });
  });
});

// 兼容旧代码里对 server 的引用（listen/error 走 frontDoor）
const server = frontDoor;


/* 绑定 + 自愈：网络未就绪 / DHCP 换址时不要退出让计划任务空转 */
function bind(reason) {
  if (reason) log(`[evoflow-webui-proxy] 重试绑定 (${reason})`);
  const onErr = (err) => {
    const code = (err && err.code) || 'UNKNOWN';
    log(`[evoflow-webui-proxy] listen ${cfg.listen}:${cfg.port} 失败 ${code}: ${err && err.message}`);
    setTimeout(() => bind(code), 5000); // 5s 后重试，永不退出
  };
  server.once('error', onErr);
  server.listen(cfg.port, cfg.listen, () => {
    server.removeListener('error', onErr);
    server.on('error', (e) => log(`[evoflow-webui-proxy] runtime error: ${e && e.message}`));
    log(`[evoflow-webui-proxy] listening ${cfg.listen}:${cfg.port} -> ${cfg.target} (XFF overwrite enabled)`);
    if (httpsServer) log('[evoflow-webui-proxy] 同端口已启用 HTTPS（自签名证书 tls/evoflow-lan.*.pem）');
    else log('[evoflow-webui-proxy] 未找到 TLS 证书，仅提供 HTTP');
    if (CREDS) {
      log(`[evoflow-webui-proxy] auth: Basic + 签名 Cookie 强制开启，用户名=${CREDS.username}`);
      if (CREDS.created_at && Date.now() - Date.parse(CREDS.created_at) < 60000) {
        log(`[evoflow-webui-proxy] 首次运行，已生成口令（仅此一次打印，见 ${CREDS_FILE}）：${CREDS.password}`);
      }
    } else {
      log('[evoflow-webui-proxy] auth: 已关闭（--no-auth）— 任何局域网设备可无凭据访问，仅可在受信网络使用');
    }
  });
}
bind();
