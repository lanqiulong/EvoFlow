/**
 * EvoFlow WebUI 看门狗单元测试（零依赖，node:test）
 *
 * 运行：node --test D:/EvoFlow/webui-proxy/watchdog.test.mjs
 *
 * 覆盖：判定逻辑、超时/拒绝/500/空壳响应、端口自环纠偏、状态文件读写、
 *       HTTPS 与自环兜底（集成用例，需服务在跑，默认跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeProbe, httpGet, probe, CFG } from './watchdog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = '<!DOCTYPE html><html lang="zh-CN"><head></head><body>ok</body></html>';

/* ------------------------------------------------ 判定逻辑（纯函数，无需服务） */
test('judgeProbe: 健康检查失败 → stage=health，且不再看首页', () => {
  const r = judgeProbe({ ok: false, error: 'ECONNREFUSED' }, { ok: true, body: HTML });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'health');
  assert.equal(r.detail.error, 'ECONNREFUSED');
});

test('judgeProbe: /health 超时 → 判定失败（8382 自环时的真实表现）', () => {
  const r = judgeProbe({ ok: false, error: 'TIMEOUT', ms: 8000 }, { ok: false, error: 'skipped' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'health');
});

test('judgeProbe: 首页 5xx → stage=root', () => {
  const r = judgeProbe({ ok: true }, { ok: false, status: 502, body: '{"detail":"gateway unavailable"}' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'root');
});

test('judgeProbe: 首页 200 但返回 JSON（代理错配）→ stage=root-body', () => {
  const r = judgeProbe({ ok: true }, { ok: true, status: 200, body: '{"detail":"Not Found"}' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'root-body');
});

test('judgeProbe: 首页空响应体 → stage=root-body（不误判为正常）', () => {
  const r = judgeProbe({ ok: true }, { ok: true, status: 200, body: '' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'root-body');
});

test('judgeProbe: 全绿 → ok=true，且带回原始探测明细', () => {
  const r = judgeProbe({ ok: true, status: 200 }, { ok: true, status: 200, body: HTML });
  assert.equal(r.ok, true);
  assert.equal(r.health.status, 200);
  assert.equal(r.page.status, 200);
});

/* ------------------------------------------------ 真实网络探测（本地临时服务） */
test('httpGet: 正常响应 → ok=true 并记录状态码', async () => {
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = await httpGet('http://127.0.0.1:' + port + '/', 3000);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  srv.close();
});

test('httpGet: 端口无人监听 → ok=false 且给出 ECONNREFUSED', async () => {
  const r = await httpGet('http://127.0.0.1:1/', 3000);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ECONNREFUSED');
});

test('httpGet: 服务假死（接受 TCP 但不回包）→ TIMEOUT，不无限挂起', async () => {
  const net = await import('node:net');
  const srv = net.createServer(() => { /* 故意不回任何数据 */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const started = Date.now();
  const r = await httpGet('http://127.0.0.1:' + port + '/health', 1200);
  const cost = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TIMEOUT');
  assert.ok(cost < 3000, '超时必须在设定值附近返回，实际 ' + cost + 'ms');
  srv.close();
});

/* ------------------------------------------------ 自我指定开关回归 */
test('probe: 会先探 /health 再探首页，顺序符合设计', async () => {
  const seen = [];
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/health') { res.writeHead(200); res.end('{"status":"healthy"}'); }
    else { res.writeHead(200); res.end(HTML); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const saved = { url: CFG.url, healthUrl: CFG.healthUrl };
  CFG.healthUrl = 'http://127.0.0.1:' + port + '/health';
  CFG.url = 'http://127.0.0.1:' + port + '/';
  const r = await probe();
  CFG.url = saved.url; CFG.healthUrl = saved.healthUrl;
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['/health', '/']);
  srv.close();
});

/* ------------------------------------------------ 配置防回归 */
test('proxy.js: 默认 target 不得等于监听端口（自环回归）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'proxy.js'), 'utf8');
  const m = src.match(/const out = \{ listen: '([^']+)', port: (\d+), target: '([^']+)'/);
  assert.ok(m, '未能解析 parseArgs 默认配置');
  const listenPort = Number(m[2]);
  const targetPort = Number(m[3].split(':')[1]);
  assert.notEqual(targetPort, listenPort, 'target 与 listen 同端口会形成自环: ' + m[3]);
  assert.equal(targetPort, 8374, 'target 必须指向网关真实端口 8374');
});

test('proxy.js: 必须存在请求级自环兜底（x-evoproxy-hop → 508）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'proxy.js'), 'utf8');
  assert.match(src, /x-evoproxy-hop/, '缺少自环标记头');
  assert.match(src, /508/, '缺少 508 截断响应');
});

/* ------------------------------------------------ 集成（需服务在跑） */
test('集成: 8382 首页与 /health 均为 2xx', async (t) => {
  const r = await httpGet(CFG.healthUrl, 5000);
  if (!r.ok) return t.skip('服务当前不可用，跳过集成用例: ' + r.error);
  const page = await httpGet(CFG.url, 5000);
  assert.equal(page.ok, true);
  assert.match(page.body, /<html/i);
});

test('集成: 自环标记请求必须被 508 截断', async (t) => {
  const http = await import('node:http');
  const r = await new Promise((resolve) => {
    const req = http.get(CFG.healthUrl, { timeout: 5000, headers: { 'x-evoproxy-hop': '1', connection: 'close' } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
  if (!r) return t.skip('服务当前不可用，跳过');
  assert.equal(r.status, 508);

  assert.match(r.body, /self-loop/);
});

/* ------------------------------------------------ IP 变更防误杀 */
test('CFG: 对外地址同时提供本机回环兜底地址，用于区分 IP 变更', () => {
  assert.match(CFG.localHealthUrl, /^http:\/\/127\.0\.0\.1:8382\/health$/);
});

test('集成: 本机回环 8382 可用（IP 变更判别依赖它）', async (t) => {
  const r = await httpGet(CFG.localHealthUrl, 5000);
  if (!r.ok) return t.skip('本机 8382 当前不可用，跳过: ' + r.error);
  assert.equal(r.status, 200);
});
