import { describe, expect, it } from 'vitest'
import { createRepeatThrottle } from '../src/lib/console-file-log.js'

/**
 * 【卡顿修复回归测试】前端 console→文件日志的重复行节流。
 *
 * 背景：唤醒耳 audio-capture 等错误风暴以 ~20 行/秒打 console，每条都经 Tauri
 * append_frontend_log 写盘，单日可堆到数百 MB 并拖慢主线程与 Gateway。
 */
describe('console-file-log 重复行节流', () => {
  it('首次必写；窗口内重复被抑制', () => {
    const t = createRepeatThrottle({ windowMs: 5000 })
    expect(t('warn|A', 1000).write).toBe(true)
    expect(t('warn|A', 1500).write).toBe(false)
    expect(t('warn|A', 4999).write).toBe(false)
  })

  it('窗口过期后放行一条，并带「重复 N 条已省略」汇总', () => {
    const t = createRepeatThrottle({ windowMs: 5000 })
    t('warn|A', 1000)
    for (let i = 0; i < 7; i++) t('warn|A', 1100 + i)
    const after = t('warn|A', 7000)
    expect(after.write).toBe(true)
    expect(after.summary).toContain('7')
    expect(after.summary).toContain('省略')
  })

  it('放行后计数归零，不会把历史条数重复累加', () => {
    const t = createRepeatThrottle({ windowMs: 5000 })
    t('warn|A', 1000)
    for (let i = 0; i < 7; i++) t('warn|A', 1100 + i)
    expect(t('warn|A', 7000).summary).toContain('7')
    // 紧接着再来一条：不应再报历史 7 条
    expect(t('warn|A', 7100).write).toBe(false)
    const next = t('warn|A', 13000)
    expect(next.summary).toContain('1')
    expect(next.summary).not.toContain('8')
  })

  it('不同 level / 不同文本各自独立，不互相吞掉', () => {
    const t = createRepeatThrottle({ windowMs: 5000 })
    expect(t('warn|A', 1000).write).toBe(true)
    expect(t('error|A', 1001).write).toBe(true)
    expect(t('warn|B', 1002).write).toBe(true)
    expect(t('warn|A', 1003).write).toBe(false)
  })

  it('指纹表超上限时淘汰最早项，长跑不涨内存且不影响新 key', () => {
    const t = createRepeatThrottle({ windowMs: 5000, maxKeys: 3 })
    expect(t('log|k1', 1000).write).toBe(true)
    expect(t('log|k2', 1001).write).toBe(true)
    expect(t('log|k3', 1002).write).toBe(true)
    // 第 4 个 key 触发淘汰 k1
    expect(t('log|k4', 1003).write).toBe(true)
    // k1 已被淘汰 → 视为首次，重新放行（而不是被永久抑制）
    expect(t('log|k1', 1004).write).toBe(true)
  })

  it('风暴场景：1 秒 20 条 × 60 秒，落盘条数应为个位数', () => {
    const t = createRepeatThrottle({ windowMs: 5000 })
    let written = 0
    for (let ms = 0; ms < 60_000; ms += 50) {
      if (t('warn|audio-capture', ms).write) written += 1
    }
    // 60s / 5s 窗口 ≈ 12 条（含首条），对比原始 1200 条
    expect(written).toBeLessThanOrEqual(13)
    expect(written).toBeGreaterThanOrEqual(11)
  })
})
