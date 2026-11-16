import { describe, expect, it } from 'vitest'
import { bangkokMonthRange, bangkokParts, bangkokTodayLabel, formatPromptTime, formatThaiDateLong, formatThaiShort, formatHhmm, formatRelativeDue, formatThaiWeekdayDay } from '@/server/time/bangkok'

describe('bangkok time', () => {
  it('shifts to UTC+7 wall-clock parts', () => {
    expect(bangkokParts(new Date('2026-11-12T02:15:00Z'))).toEqual({ y: 2026, m: 11, d: 12, hh: 9, mm: 15 })
  })

  it('formats prompt time and today label', () => {
    expect(formatPromptTime(new Date('2026-11-12T02:15:00Z'))).toBe('2026-11-12 09:15')
    expect(bangkokTodayLabel(new Date('2026-11-12T17:30:00Z'))).toBe('2026-11-13')
  })

  it('formats a short Thai date with the weekday (UX review 4.2)', () => {
    expect(formatThaiShort(new Date('2026-11-12T02:15:00Z'))).toBe('พฤ. 12 พ.ย. 09:15')
    expect(formatThaiWeekdayDay(new Date('2026-11-16T16:59:00Z'))).toBe('จ. 16 พ.ย.') // 23:59 Bangkok
    expect(formatHhmm(new Date('2026-11-16T17:05:00Z'))).toBe('00:05')
  })

  it('says วันนี้ / พรุ่งนี้ / เมื่อวาน by the Bangkok calendar day (UX review 4.3)', () => {
    const now = new Date('2026-11-16T02:00:00Z') // จ. 16 พ.ย. 09:00 Bangkok
    expect(formatRelativeDue(new Date('2026-11-16T10:00:00Z'), now)).toBe('วันนี้ 17:00')
    expect(formatRelativeDue(new Date('2026-11-16T17:30:00Z'), now)).toBe('พรุ่งนี้ 00:30') // 00:30 on the 17th
    expect(formatRelativeDue(new Date('2026-11-15T10:00:00Z'), now)).toBe('เมื่อวาน 17:00')
    expect(formatRelativeDue(new Date('2026-11-19T10:00:00Z'), now)).toBe('พฤ. 19 พ.ย. 17:00')
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
