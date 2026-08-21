import { describe, expect, it } from 'vitest'
import { formatResetTime, formatUsageNumber } from '../src/client/locale-format.ts'

describe('Codex usage locale formatting', () => {
  it('uses DSH locale instead of the browser default for reset times', () => {
    const timestamp = Date.UTC(2026, 7, 20, 12, 34)
    const english = formatResetTime(timestamp, 'en')
    const chinese = formatResetTime(timestamp, 'zh')

    expect(english).toContain('Aug')
    expect(english).not.toContain('年')
    expect(chinese).toContain('年')
    expect(chinese).toContain('月')
  })

  it('uses DSH locale for numeric usage metadata', () => {
    expect(formatUsageNumber(1234.5, 'en')).toBe(new Intl.NumberFormat('en', {
      maximumFractionDigits: 2,
    }).format(1234.5))
    expect(formatUsageNumber(1234.5, 'zh')).toBe(new Intl.NumberFormat('zh', {
      maximumFractionDigits: 2,
    }).format(1234.5))
  })
})
