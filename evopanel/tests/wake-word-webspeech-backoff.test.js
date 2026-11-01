import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isWebSpeechEarRunning,
  startWebSpeechEar,
  stopWebSpeechEar,
} from '../src/lib/wake-word-webspeech.js'

/**
 * 【BUG修复回归测试】唤醒词 Web Speech 采集失败退避/停耳。
 *
 * 缺陷：旧实现只要 rec.start() 不同步抛异常（Chrome 无麦时正是如此，失败以异步
 * onerror(audio-capture) 到达）就清零 captureFailStreak，导致 streak 永远停在 1，
 * 退避档位恒为最小值、停耳阈值 CAPTURE_FAIL_STOP_AFTER(8) 永远达不成 → 耳朵无限重试刷屏。
 * 修复：清零改由 onresult（真实识别结果 = 麦确实可用）触发。
 */
class MockRecognition {
  static instances = []
  constructor() {
    MockRecognition.instances.push(this)
    this.startCalls = 0
    this.onresult = null
    this.onerror = null
    this.onend = null
  }
  start() {
    this.startCalls += 1 // 模拟 Chrome：无麦时 start() 也不抛异常
  }
  stop() {}
  abort() {}
}

function lastRec() {
  return MockRecognition.instances[MockRecognition.instances.length - 1]
}

/** 触发一轮「audio-capture 硬失败 → onend 续听 → 退避计时到期重试」 */
function failOnce(rec) {
  rec.onerror({ error: 'audio-capture' })
  // 达到停耳阈值后 stopWebSpeechEar() 会把 onend 置空（耳朵已停）——这是预期终点
  if (typeof rec.onend === 'function') rec.onend()
  vi.advanceTimersByTime(30000) // 覆盖最大退避档位，确保 tryStart 被调度
}

beforeEach(() => {
  vi.useFakeTimers()
  MockRecognition.instances = []
  window.SpeechRecognition = MockRecognition
})

afterEach(() => {
  stopWebSpeechEar()
  vi.useRealTimers()
  delete window.SpeechRecognition
})

describe('wake-word-webspeech 采集失败退避（BUG修复）', () => {
  it('连续 audio-capture 达到阈值后停耳，不再无限重试', async () => {
    await startWebSpeechEar()
    expect(isWebSpeechEarRunning()).toBe(true)
    const rec = lastRec()

    // 修复前：streak 每轮被 tryStart 清零 → 永远到不了 8 → 永不停耳。
    // 修复后：连续硬失败累计到 CAPTURE_FAIL_STOP_AFTER(8) 即停耳。
    for (let i = 0; i < 10; i++) {
      failOnce(rec)
      if (!isWebSpeechEarRunning()) break
    }
    expect(isWebSpeechEarRunning()).toBe(false)
  })

  it('退避随失败次数递增（重试间隔逐步拉大，而非恒定 3s）', async () => {
    await startWebSpeechEar()
    const rec = lastRec()
    const startCallsAfterFirst = []

    for (let i = 0; i < 5; i++) {
      rec.onerror({ error: 'audio-capture' })
      rec.onend()
      vi.advanceTimersByTime(30000)
      startCallsAfterFirst.push(rec.startCalls)
    }
    // 每轮 onend 都要真正重试（start 被调用），证明退避是「延迟重试」而非「丢弃」
    for (let i = 1; i < startCallsAfterFirst.length; i++) {
      expect(startCallsAfterFirst[i]).toBeGreaterThan(startCallsAfterFirst[i - 1])
    }
    expect(rec.startCalls).toBeGreaterThanOrEqual(5)
  })

  it('onresult（麦恢复吐字）后清零退避，再次失败从头累计，不会立刻停耳', async () => {
    await startWebSpeechEar()
    const rec = lastRec()

    // 先累计 3 次硬失败
    for (let i = 0; i < 3; i++) failOnce(rec)
    expect(isWebSpeechEarRunning()).toBe(true)

    // 麦克风恢复：吐出一次（非唤醒词）识别结果 → 清零 streak
    rec.onresult({ resultIndex: 0, results: [] })

    // 再来 5 次硬失败：若未清零则 3+5=8 会停耳；清零后应仍为 5<8 而继续运行
    for (let i = 0; i < 5; i++) failOnce(rec)
    expect(isWebSpeechEarRunning()).toBe(true)
  })
})
