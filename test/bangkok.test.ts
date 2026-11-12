import { describe, expect, it } from 'vitest'
import {
  bangkokMonthRange,
  bangkokParts,
  bangkokTodayLabel,
  formatPromptTime,
  formatThaiDateLong,
  formatThaiShort,
} from '@/server/time/bangkok'

describe('bangkok time', () => {
  it('shifts to UTC+7 wall-clock parts', () => {
    expect(bangkokParts(new Date('2026-11-12T02:15:00Z'))).toEqual({ y: 2026, m: 11, d: 12, hh: 9, mm: 15 })
  })

  it('formats prompt time and today label', () => {
    expect(formatPromptTime(new Date('2026-11-12T02:15:00Z'))).toBe('2026-11-12 09:15')
    expect(bangkokTodayLabel(new Date('2026-11-12T17:30:00Z'))).toBe('2026-11-13')
  })

  it('formats a short Thai date', () => {
    expect(formatThaiShort(new Date('2026-11-12T02:15:00Z'))).toBe('12 พ.ย. 09:15')
  })

  it('formats a long Thai date with the Buddhist year', () => {
    expect(formatThaiDateLong(new Date('2026-11-30T17:00:00Z'))).toBe('1 ธันวาคม 2569')
  })

  it('puts 17:00 UTC on the last day into the next Bangkok month', () => {
    const r = bangkokMonthRange(new Date('2026-11-30T17:00:00Z'))
    expect(r.start.toISOString()).toBe('2026-11-30T17:00:00.000Z')
    expect(r.end.toISOString()).toBe('2026-12-31T17:00:00.000Z')
    expect(r.monthStartBkk).toBe('2026-12-01')
  })

  it('keeps one second earlier in the current month', () => {
    expect(bangkokMonthRange(new Date('2026-11-30T16:59:59Z')).monthStartBkk).toBe('2026-11-01')
  })

  it('rolls the year over', () => {
    const r = bangkokMonthRange(new Date('2026-12-31T17:00:00Z'))
    expect(r.monthStartBkk).toBe('2027-01-01')
    expect(r.start.toISOString()).toBe('2026-12-31T17:00:00.000Z')
    expect(r.end.toISOString()).toBe('2027-01-31T17:00:00.000Z')
  })
})
