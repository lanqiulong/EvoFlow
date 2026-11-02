/**
 * Mirror browser ``console.*`` and global errors to ``~/.evoflow/logs/frontend-YYYY-MM-DD.log``
 * (Tauri ``append_frontend_log``). Enabled for desktop builds so release packages are debuggable.
 */

import { isTauri } from './panel-login.js'

const MAX_LINE = 12_000
let installed = false

/** 同一条日志（level+text）在窗口内只落盘一次，防日志风暴撑爆磁盘并拖慢主线程 */
const REPEAT_WINDOW_MS = 5_000
/** 指纹表上限，防长跑内存增长（超出按最早插入淘汰） */
const REPEAT_MAX_KEYS = 64

/**
 * 【卡顿修复】重复行节流器（纯函数，便于单测边界）。
 *
 * 背景：唤醒耳 audio-capture 等错误风暴会以 ~20 行/秒打 console，每条都经
 * Tauri `append_frontend_log` → spawn_blocking 写盘，单日可堆到数百 MB 并拖慢 UI。
 * 这里对「同 level + 同文本」做窗口内合并，窗口过期后放行一条并补汇总，
 * 既降噪又保留心跳（不会把持续故障误报成已恢复）。
 *
 * @param {{ windowMs?: number, maxKeys?: number }} [opts]
 * @returns {(key: string, now: number) => { write: boolean, summary: string }}
 */
export function createRepeatThrottle(opts = {}) {
  const windowMs = opts.windowMs ?? REPEAT_WINDOW_MS
  const maxKeys = opts.maxKeys ?? REPEAT_MAX_KEYS
  /** @type {Map<string, { at: number, suppressed: number }>} */
  const seen = new Map()
  return (key, now) => {
    const prev = seen.get(key)
    if (prev && now - prev.at < windowMs) {
      prev.suppressed += 1
      return { write: false, summary: '' }
    }
    const suppressed = prev ? prev.suppressed : 0
    if (prev) {
      prev.at = now
      prev.suppressed = 0
    } else {
      if (seen.size >= maxKeys) seen.delete(seen.keys().next().value)
      seen.set(key, { at: now, suppressed: 0 })
    }
    return {
      write: true,
      summary: suppressed > 0 ? `（同类日志重复 ${suppressed} 条已省略）` : '',
    }
  }
}

const throttle = createRepeatThrottle()

function formatConsoleArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) {
        return a.stack || a.message || String(a)
      }
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

async function emit(level, text) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('append_frontend_log', {
      level: level === 'log' ? 'info' : level,
      message: text,
    })
  } catch {
    /* best-effort */
  }
}

async function writeLine(level, message) {
  if (!isTauri || !window.__TAURI__) return
  // Best-effort; silently skip if file-log is disabled.
  try {
    if (localStorage.getItem('evoflow-disable-file-log') === '1') return
  } catch {}
  const text = String(message || '').slice(0, MAX_LINE)
  if (!text) return
  // 【卡顿修复】重复行合并：被压掉的条数在窗口过期后以一条汇总补回
  const verdict = throttle(`${level}|${text}`, Date.now())
  if (!verdict.write) return
  if (verdict.summary) await emit('info', verdict.summary)
  await emit(level, text)
}

/**
 * Patch ``console.log/info/warn/error/debug`` and window error handlers (idempotent).
 */
export function installConsoleFileLog() {
  if (installed || typeof window === 'undefined' || !isTauri) return
  installed = true

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level]?.bind(console)
    if (!orig) continue
    console[level] = (...args) => {
      orig(...args)
      void writeLine(level, formatConsoleArgs(args))
    }
  }

  window.addEventListener('error', (ev) => {
    void writeLine('error', `[uncaught] ${ev.message} @ ${ev.filename || '?'}:${ev.lineno || '?'}`)
  })

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason
    const msg = r instanceof Error ? r.stack || r.message : String(r ?? '')
    void writeLine('error', `[unhandledrejection] ${msg}`)
  })
}
