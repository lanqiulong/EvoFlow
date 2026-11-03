#!/usr/bin/env node
/**
 * gateway-sentinel.mjs — gateway 并发锁死早期哨兵
 *
 * 目的：watchdog 只探活 503 返回码（事后发现，假死已全面出现）；本哨兵提前约 40 分钟
 *       发现 uvicorn 并发锁死前兆（"Exceeded concurrency limit" 在日志中持续累积）。
 *
 * 纪律：绝不重启任何进程（重启 gateway 由桌面端自身/人工执行）。本脚本只读日志 + 计数 + 告警。
 *       "该修"是重启 gateway 子进程；此脚本只负责"更早发现"。
 *
 * 判别逻辑：
 *   读当日 gateway-YYYY-MM-DD.log 尾部，统计其中 "Exceeded concurrency limit" 出现次数。
 *   若最后一条超限发生在最近 RECENT_MS 内，且近 WINDOW_MINUTES 内超限次数 ≥ THRESHOLD，
 *   判定"并发锁死前兆"，写 ALERT 到 sentinel.log + 更新 sentinel-state.json。
 *
 * 日志目录：默认 %USERPROFILE%\.evoflow\logs；若以 SYSTEM 跑计划任务（homedir 不对），
 *           用环境变量 EVOWEB_GATEWAY_LOG_DIR 显式指定真实日志目录。
 *
 * 用法：node gateway-sentinel.mjs            # 单次体检（配计划任务每1分钟跑）
 *       node gateway-sentinel.mjs --dry-run # 只读不写状态（调试）
 *
 * 状态文件：gateway-sentinel-state.json
 * 运行日志：gateway-sentinel.log（>2MB 自动滚成 .log.1）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置 ----------
const CFG = {
  // gateway 日志目录（按日滚动 gateway-YYYY-MM-DD.log）
  // 【BUG修复】支持环境变量覆盖：计划任务以 SYSTEM 跑时 os.homedir() 是 systemprofile，
  // 找不到真实日志目录，需显式传 EVOWEB_GATEWAY_LOG_DIR 指向 C:\Users\Administrator\.evoflow\logs
  logDir: process.env.EVOWEB_GATEWAY_LOG_DIR || 'C:/Users/Administrator/.evoflow/logs',
  // 判别阈值：近 WINDOW_MINUTES 分钟内超限 ≥ THRESHOLD 次 → 前兆
  WINDOW_MINUTES: 5,
  THRESHOLD: 20,
  // 最后一条超限距今 ≥ RECENT_MS 才算"正在活跃"
  RECENT_MS: 90 * 1000,
  // 只扫日志尾部最近 N 字节（文件很大，避免整读）
  TAIL_BYTES: 4 * 1024 * 1024,
  stateFile: path.join(__dirname, 'gateway-sentinel-state.json'),
  logFile: path.join(__dirname, 'gateway-sentinel.log'),
};

const DRY_RUN = process.argv.includes('--dry-run');

// ---------- 日志 ----------
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
  fs.appendFileSync(CFG.logFile, line, { encoding: 'utf8' });
  // 滚日志：>2MB 时挪成 .log.1
  try {
    const st = fs.statSync(CFG.logFile);
    if (st.size > 2 * 1024 * 1024) {
      fs.copyFileSync(CFG.logFile, CFG.logFile + '.1');
      fs.truncateSync(CFG.logFile, 0);
    }
  } catch (e) { /* 滚动失败忽略 */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch (e) { return { status: 'ok', consecutiveAlerts: 0 }; }
}
function writeState(s) {
  fs.writeFileSync(CFG.stateFile, JSON.stringify(s, null, 2), 'utf8');
}

// ---------- 今日日志路径 ----------
function todayLog() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return path.join(CFG.logDir, `gateway-${date}.log`);
}

// ---------- 扫尾部并统计超限 ----------
function scanLimits(logPath) {
  let fd = null;
  try {
    const st = fs.statSync(logPath);
    const start = Math.max(0, st.size - CFG.TAIL_BYTES);
    fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const tail = buf.toString('utf8');

    // 逐行找超限，记时间戳（日志行格式：YYYY-MM-DD HH:MM:SS - uvicorn.error ...）
    const rows = [];
    const re = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*Exceeded concurrency limit.*$/gm;
    let m;
    while ((m = re.exec(tail)) !== null) {
      rows.push(new Date(m[1].replace(' ', 'T')).getTime());
    }
    return rows;
  } catch (e) {
    return null; // 文件不存在或不可读
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) {}
  }
}

// ---------- 主流程 ----------
function check() {
  const logPath = todayLog();
  const rows = scanLimits(logPath);
  const now = Date.now();

  if (rows === null) {
    // 今日日志还没有（可能 gateway 未启动 / 刚跨日 / 日志目录配错）
    log('INFO', '日志不存在或不可读: ' + logPath + '（若以 SYSTEM 跑，请设置 EVOWEB_GATEWAY_LOG_DIR）');
    if (!DRY_RUN) writeState({ status: 'no-log', consecutiveAlerts: 0, checkedAt: new Date().toISOString() });
    return { status: 'no-log' };
  }

  if (rows.length === 0) {
    // 今日日志存在但尾部无超限，正常
    if (!DRY_RUN) writeState({ status: 'ok', consecutiveAlerts: 0, totalToday: 0, checkedAt: new Date().toISOString() });
    return { status: 'ok', totalToday: 0 };
  }

  const totalToday = rows.length;
  const lastTs = rows[rows.length - 1];
  const recent = rows.filter((t) => now - t <= CFG.WINDOW_MINUTES * 60 * 1000).length; // 近窗口内超限数
  const active = (now - lastTs) <= CFG.RECENT_MS; // 是否仍在活跃超限

  const state = readState();
  const alert = active && recent >= CFG.THRESHOLD;

  if (alert) {
    const nAlerts = (state.consecutiveAlerts || 0) + 1;
    // 连续告警，越界信息
    log('ALERT', `并发锁死前兆: 近${CFG.WINDOW_MINUTES}分钟超限${recent}次，今日累计${totalToday}次，最后一条${Math.round((now-lastTs)/1000)}s前（活跃中）`);
    if (!DRY_RUN) writeState({
      status: 'concurrency-alert', consecutiveAlerts: nAlerts,
      totalToday, recentWindow: recent, lastAlertAt: new Date().toISOString(),
      lastOverLimitSec: Math.round((now - lastTs) / 1000), checkedAt: new Date().toISOString(),
    });
    return { status: 'concurrency-alert', totalToday, recent, nAlerts };
  }

  // 未达阈值：恢复或维持 ok
  if (!DRY_RUN) writeState({
    status: 'ok', consecutiveAlerts: 0, totalToday, recentWindow: recent,
    lastOverLimitSec: Math.round((now - lastTs) / 1000), checkedAt: new Date().toISOString(),
  });
  if (state.consecutiveAlerts > 0) log('RECOVERY', '并发超限已回落：最后一条超限 ' + Math.round((now - lastTs) / 1000) + 's 前，已超活跃窗口 ' + (CFG.RECENT_MS / 1000) + 's（近' + CFG.WINDOW_MINUTES + '分钟累计 ' + recent + ' 次，阈值 ' + CFG.THRESHOLD + '；未达活跃判定，故溢出回落，若再活跃将立即 ALERT）');
  return { status: 'ok', totalToday, recent };
}

const IS_ENTRY = (() => {
  try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
  catch (e) { return false; }
})();

if (IS_ENTRY) {
  const r = check();
  process.stdout.write(JSON.stringify(r) + '\n');
}

export { CFG, check, scanLimits };
