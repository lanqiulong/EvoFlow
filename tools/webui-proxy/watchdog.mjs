#!/usr/bin/env node
/**
 * EvoFlow WebUI 可用性看门狗（零第三方依赖，Node 18+）
 *
 * 职责：每 1 分钟检查 http://192.168.9.193:8382/ 是否可正常访问；
 * 异常即自动修复（重启 WebUI 反向代理），并落盘日志与状态文件。
 *
 * 【重要边界】只修复“代理层”，绝不重启 evoflow.exe（桌面端）。
 * 桌面端同时托管 Gateway 与 agent 进程，重启它会打断正在跑的会话/任务。
 *
 * 修复阶梯（fail → 逐级升级，每级修复后立刻复测）：
 *   L1 端口未监听             → schtasks 启动 EvoFlow WebUI Proxy
 *   L2 端口在但无响应/超时    → 杀掉 proxy.js 进程 → 重启
 *   L3 代理正常但上游 8374 挂 → 只告警（人工介入），不重启任何进程
 *
 * 用法：
 *   node watchdog.mjs            # 单次检查 + 按需修复（计划任务调用）
 *   node watchdog.mjs --dry-run  # 只检查不修复
 *   node watchdog.mjs --loop     # 常驻循环（调试用，60s）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  // 【BUG修复】优先用本机当前局域网 IPv4 拼地址：DHCP 换址后不会把“IP 变了”
  // 误判成“服务挂了”从而每分钟误杀代理。可用环境变量强制指定。
  url: process.env.EVOWEB_CHECK_URL || ('http://' + (process.env.EVOWEB_LAN_IP || '192.168.9.193') + ':8382/'),
  healthUrl: process.env.EVOWEB_CHECK_HEALTH || ('http://' + (process.env.EVOWEB_LAN_IP || '192.168.9.193') + ':8382/health'),
  // 本机回环地址，用于区分“代理真挂”与“只是对外 IP 变了”
  localHealthUrl: 'http://127.0.0.1:8382/health',
  upstreamUrl: 'http://127.0.0.1:8374/health', // 网关真实端口
  proxyPort: 8382,
  taskName: 'EvoFlow WebUI Proxy',
  timeoutMs: 8000,
  maxRepairAttempts: 3,
  failThreshold: 1, // 连续失败达到该值才修复，避免单次抖动就重启
  logFile: path.join(__dirname, 'watchdog.log'),
  stateFile: path.join(__dirname, 'watchdog-state.json'),
  logMaxBytes: 2 * 1024 * 1024,
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LOOP = args.includes('--loop');

/* ---------------------------------------------------------------- 日志 */
function log(level, msg) {
  const line = new Date().toISOString() + ' [' + level + '] ' + msg;
  try {
    if (fs.existsSync(CFG.logFile) && fs.statSync(CFG.logFile).size > CFG.logMaxBytes) {
      fs.renameSync(CFG.logFile, CFG.logFile + '.1');
    }
    fs.appendFileSync(CFG.logFile, line + '\n');
  } catch (e) { /* 日志失败不影响修复 */ }
  console.log(line);
}

function readState() {
  try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); } catch (e) { return {}; }
}

function writeState(patch) {
  const next = Object.assign(readState(), patch, { updatedAt: new Date().toISOString() });
  try { fs.writeFileSync(CFG.stateFile, JSON.stringify(next, null, 2) + '\n'); } catch (e) { /* 忽略 */ }
}

/* ---------------------------------------------------------------- 探测 */
function httpGet(url, timeoutMs) {
  const ms = timeoutMs || CFG.timeoutMs;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ms: Date.now() - startedAt }, r));
    };
    let req;
    try {
      req = http.get(url, { timeout: ms, headers: { connection: 'close' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { if (body.length < 512) body += chunk; });
        res.on('end', () => done({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body: body }));
      });
    } catch (e) {
      return done({ ok: false, error: 'THROW:' + e.message });
    }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'TIMEOUT' }); });
    req.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

// 【BUG修复·可测性】判定逻辑抽成纯函数：输入/health 与首页探测结果，输出结论。
// 单元测试直接覆盖它，不需要真实服务在跑。
function judgeProbe(health, page) {
  if (!health.ok) return { ok: false, stage: 'health', detail: health };
  if (!page.ok) return { ok: false, stage: 'root', detail: page };
  if (!/<!DOCTYPE html|<html/i.test(page.body || '')) return { ok: false, stage: 'root-body', detail: page };
  return { ok: true, health: health, page: page };
}

async function probe() {
  const health = await httpGet(CFG.healthUrl);
  const page = health.ok ? await httpGet(CFG.url) : { ok: false, error: "skipped" };
  return judgeProbe(health, page);
}

/* ---------------------------------------------------------- 端口与进程 */
function netstatLines() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.split(/\r?\n/).filter((l) => l.indexOf(':' + CFG.proxyPort) >= 0);
  } catch (e) {
    return [];
  }
}

function isListening() {
  const needle = '0.0.0.0:' + CFG.proxyPort;
  return netstatLines().some((l) => l.indexOf('LISTENING') >= 0 && l.indexOf(needle) >= 0);
}

function connectionCount() {
  const lines = netstatLines();
  return { total: lines.length, established: lines.filter((l) => l.indexOf('ESTABLISHED') >= 0).length };
}

function proxyPids() {
  const pids = [];
  for (const l of netstatLines()) {
    const m = l.match(/LISTENING\s+(\d+)/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

function run(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return 'ERR:' + ((e.stderr || '') + ' ' + (e.message || '')).trim();
  }
}

/* ---------------------------------------------------------------- 修复 */
async function repairOnce(attempt) {
  const verdict = await probe();
  if (verdict.ok) return { fixed: true, action: 'probe-ok', attempt: attempt };

  if (DRY_RUN) {
    log('WARN', '[dry-run] 检测到异常(' + verdict.stage + ')，未做任何修复');
    return { fixed: false, action: 'dry-run', attempt: attempt };
  }

  let action;

  // L3：先判上游，上游挂了重启代理也没用
  const up = await httpGet(CFG.upstreamUrl, 5000);
  if (!up.ok) {
    log('ERROR', '上游网关 127.0.0.1:8374 不健康 (' + (up.error || up.status) + ')；代理层无法自愈，需人工检查桌面端 EvoFlow');
    return { fixed: false, action: 'upstream-down', attempt: attempt, needsHuman: true };
  }

  // 【BUG修复】IP 变更判别：对外 IP 不通但本机回环 8382 正常 → 是地址变了，不是服务挂了。
  // 这种情况重启代理毫无意义（还会打断在线会话），只告警等人工改地址。
  const local = await httpGet(CFG.localHealthUrl, 5000);
  if (local.ok) {
    log('ERROR', '对外地址 ' + CFG.url + ' 不可达，但本机回环 8382 正常；判断为机器局域网 IP 已变更，不做重启。' +
      '请更新计划任务参数里的 EVOWEB_LAN_IP 或本脚本 CFG，并同步代理证书/文档。');
    return { fixed: false, action: 'ip-changed', attempt: attempt, needsHuman: true };
  }

  if (!isListening()) {
    action = 'start-task';
    log('WARN', '端口 ' + CFG.proxyPort + ' 未监听，尝试启动计划任务 ' + CFG.taskName);
    log('INFO', 'schtasks /run -> ' + (run('schtasks', ['/run', '/tn', CFG.taskName]).trim() || 'ok'));
  } else {
    const pids = proxyPids();
    action = 'restart-proxy(' + pids.join(',') + ')';
    log('WARN', '端口 ' + CFG.proxyPort + ' 在监听但请求失败(' + verdict.stage + ': ' +
      JSON.stringify(verdict.detail).slice(0, 160) + ')，连接数=' + JSON.stringify(connectionCount()) +
      '，重启代理 PID=' + pids.join(','));
    run('schtasks', ['/end', '/tn', CFG.taskName]);
    for (const pid of pids) {
      log('INFO', 'taskkill ' + pid + ' -> ' + (run('taskkill', ['/PID', String(pid), '/F']).trim() || 'ok'));
    }
    for (let i = 0; i < 20 && isListening(); i++) await new Promise((r) => setTimeout(r, 250));
    run('schtasks', ['/run', '/tn', CFG.taskName]);
  }

  // 等端口就绪并复测（最多 15s）
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!isListening()) continue;
    const again = await probe();
    if (again.ok) {
      log('RECOVERY', '第 ' + attempt + ' 次修复成功（' + action + '），耗时约 ' + (i + 1) + 's');
      return { fixed: true, action: action, attempt: attempt };
    }
  }

  log('ERROR', '第 ' + attempt + ' 次修复失败（' + action + '）');
  return { fixed: false, action: action, attempt: attempt };
}

/* ---------------------------------------------------------------- 主流程 */
async function checkAndRepair() {
  const state = readState();
  const failures = state.consecutiveFailures || 0;
  const first = await probe();

  if (first.ok) {
    if (failures > 0) log('RECOVERY', '服务已恢复正常（此前连续失败 ' + failures + ' 次）');
    writeState({
      status: 'up',
      consecutiveFailures: 0,
      lastOkAt: new Date().toISOString(),
      lastProbeMs: first.page ? first.page.ms : null,
      connections: connectionCount(),
    });
    return { status: 'up' };
  }

  const nf = failures + 1;
  log('WARN', '探测失败(' + first.stage + ': ' + JSON.stringify(first.detail).slice(0, 200) + ')，连续失败 ' + nf + '/' + CFG.failThreshold);
  writeState({ status: 'probing', consecutiveFailures: nf, lastFailAt: new Date().toISOString() });

  if (nf < CFG.failThreshold) return { status: 'failing' };

  let result = { fixed: false };
  for (let i = 1; i <= CFG.maxRepairAttempts; i++) {
    result = await repairOnce(i);
    if (result.fixed) break;
    if (result.needsHuman) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (result.fixed) {
    writeState({ status: 'repaired', consecutiveFailures: 0, lastRepairAt: new Date().toISOString(), lastRepairAction: result.action });
    return { status: 'repaired', action: result.action };
  }

  // 【BUG修复】区分“修不好”与“不该修”：ip-changed/upstream-down 属于需人工的已知原因，
  // 状态单独标注，便于外部读取时不再按“服务宕了”处理。
  const humanReason = { 'ip-changed': 'ip-changed', 'upstream-down': 'upstream-down' }[result.action] || 'down';
  writeState({ status: humanReason, consecutiveFailures: nf, lastRepairAt: new Date().toISOString(), lastRepairAction: result.action, needsHuman: !!result.needsHuman });
  log('ERROR', '自动修复未成功（' + result.action + '），状态标记 ' + humanReason + '，等待下一轮或人工介入');
  return { status: humanReason, action: result.action };
}

// 【BUG修复·可测性】对外导出纯函数/探测函数，供 watchdog.test.mjs 直接引用；
// 仅在作为入口脚本执行时才跑主流程，被 import 时不产生副作用。
export { CFG, httpGet, probe, judgeProbe, isListening, connectionCount, proxyPids, checkAndRepair, log };

const IS_ENTRY = (() => {
  try { return path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url); }
  catch (e) { return false; }
})();

if (IS_ENTRY) {
  (async () => {
    if (LOOP) {
      for (;;) {
        await checkAndRepair();
        await new Promise((r) => setTimeout(r, 60000));
      }
    } else {
      const r = await checkAndRepair();
      log('INFO', '本轮结果: ' + r.status + (r.action ? ' (' + r.action + ')' : ''));
    }
  })().catch((e) => {
    log('ERROR', '看门狗异常退出: ' + ((e && e.stack) || e));
    process.exitCode = 1;
  });
}
