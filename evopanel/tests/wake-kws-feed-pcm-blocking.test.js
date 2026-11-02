/**
 * 【BUG修复回归测试】唤醒词喂 PCM 命令不得占用 WebView UI 主线程。
 *
 * 缺陷：`wake_kws_feed_pcm` 曾是同步 `#[tauri::command]`。Tauri 的同步命令在 WebView
 * UI 主线程执行（见 src-tauri/src/commands/browser_cdp.rs 顶部注释），而该命令每次都要
 * `stdin.write_all + flush` 写 KWS sidecar。前端每 ~100ms 喂一个 PCM 块（1600 samples
 * @16kHz），sidecar 一旦停顿、管道缓冲写满，write 即阻塞 → 整个窗口画面冻结。
 *
 * 修复：改成 `pub async fn` + `tauri::async_runtime::spawn_blocking`，把阻塞 IO 挪到
 * Tauri 阻塞池（与 browser_cdp_command 同一既有模式）。本测试用静态源码断言守住这个契约，
 * 防止后续重构悄悄改回同步命令（这类回归无法用 JS 单测覆盖，因为 Rust 侧不在 vitest 范围）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// vitest 的 root 即 evopanel/（同 tests/font-size-tokens.test.js 约定）
const ROOT = process.cwd()
const RUST_SRC = readFileSync(
  join(ROOT, 'src-tauri/src/commands/wake_kws.rs'),
  'utf8',
)

/** 截取 wake_kws_feed_pcm 函数体（到下一个 #[tauri::command] 为止） */
function feedPcmBlock() {
  const start = RUST_SRC.indexOf('pub async fn wake_kws_feed_pcm')
  expect(start, 'wake_kws_feed_pcm 应存在且为 async fn').toBeGreaterThan(-1)
  const next = RUST_SRC.indexOf('#[tauri::command]', start)
  return RUST_SRC.slice(start, next === -1 ? undefined : next)
}

describe('wake_kws_feed_pcm：阻塞 IO 必须离开 UI 主线程', () => {
  it('命令声明为 async（同步命令会在 WebView UI 主线程执行）', () => {
    expect(feedPcmBlock()).toMatch(/^pub\s+async\s+fn\s+wake_kws_feed_pcm/)
  })

  it('函数体内通过 spawn_blocking 执行写管道', () => {
    const block = feedPcmBlock()
    expect(block).toMatch(/spawn_blocking/)
    // 阻塞写必须在闭包内，不能在闭包外直接调用
    const spawnIdx = block.indexOf('spawn_blocking')
    const writeIdx = block.indexOf('write_line(')
    expect(writeIdx, 'write_line 应仍在函数内').toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(spawnIdx)
  })

  it('不再以 State<..> 作为命令参数（State 借用无法跨线程）', () => {
    const sig = feedPcmBlock().split('{')[0]
    expect(sig).not.toMatch(/State\s*<\s*'_/)
    expect(sig).toMatch(/AppHandle/)
  })

  it('保留空块快速返回语义（前端 feedBusy 依赖它不堆积）', () => {
    expect(feedPcmBlock()).toMatch(/if\s+b64\.is_empty\(\)\s*\{\s*return\s+Ok\(\(\)\);/)
  })
})
