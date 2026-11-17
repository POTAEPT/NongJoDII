import { describe, expect, it } from 'vitest'
import { bangkokCalendar, bangkokWeekdayDate, findWeekday, bangkokMonthRange, bangkokParts, bangkokTodayLabel, formatPromptTime, formatThaiDateLong, formatThaiShort, formatHhmm, formatRelativeDue, formatThaiWeekdayDay } from '@/server/time/bangkok'

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

describe('bangkokCalendar (#161)', () => {
  it('lists today and the next 14 days in Bangkok, one per line, with English and Thai weekdays', () => {
    // Tuesday 17 Nov 2026, 10:00 in Bangkok.
    const days = bangkokCalendar(new Date('2026-11-17T03:00:00Z'))
    expect(days).toHaveLength(15)
    expect(days.slice(0, 4)).toEqual([
      '- 2026-11-17 Tue อังคาร (อ.) this week, วันนี้ (today)',
      '- 2026-11-18 Wed พุธ (พ.) this week, พรุ่งนี้ (tomorrow)',
      '- 2026-11-19 Thu พฤหัสบดี (พฤ.) this week',
      '- 2026-11-20 Fri ศุกร์ (ศ.) this week',
    ])
    expect(days[9]).toBe('- 2026-11-26 Thu พฤหัสบดี (พฤ.) next week (สัปดาห์หน้า)')
    expect(days[14]).toBe('- 2026-12-01 Tue อังคาร (อ.) later')
    // Every day carries its Thai name and short form.
    const thai = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']
    for (const line of days) expect(thai.some((name) => line.includes(` ${name} (`))).toBe(true)
    expect(days.filter((l) => l.includes('วันนี้'))).toHaveLength(1)
    expect(days.filter((l) => l.includes('พรุ่งนี้'))).toHaveLength(1)
  })

  it('uses the Bangkok date late at night UTC', () => {
    // 23:30 UTC on 16 Nov is 06:30 on Tuesday 17 Nov in Bangkok.
    expect(bangkokCalendar(new Date('2026-11-16T23:30:00Z'), 1)).toEqual([
      '- 2026-11-17 Tue อังคาร (อ.) this week, วันนี้ (today)', '- 2026-11-18 Wed พุธ (พ.) this week, พรุ่งนี้ (tomorrow)',
    ])
  })
})

describe('findWeekday', () => {
  it.each([
    ['ส่งวันพฤหัส', 4], ['พฤหัสบดีนะ', 4], ['ส่งวันพฤ', 4], ['พฤ. ส่ง', 4], ['ศุกร์นี้ห้าโมงเย็น', 5], ['ส่ง ศ. นะ', 5],
    ['วันจันทร์', 1], ['อังคาร', 2], ['พุธ', 3], ['เสาร์', 6], ['วันอาทิตย์', 7], ['วันอา', 7], ['due Fri', 5], ['by friday', 5],
  ])('%j names weekday %i, this week', (text, weekday) => {
    expect(findWeekday(text)).toEqual({ weekday, nextWeek: false })
  })

  it.each([['พฤหัสหน้า', 4], ['ส่งวันศุกร์ สัปดาห์หน้า', 5], ['พฤหัสอาทิตย์หน้า', 4], ['วันอาทิตย์หน้า', 7], ['next Friday', 5], ['Mon next week', 1]])(
    '%j names weekday %i of the following week', (text, weekday) => {
      expect(findWeekday(text)).toEqual({ weekday, nextWeek: true })
    },
  )

  it.each([
    'ทำสไลด์ให้', 'ภายใน 20 พ.ย.', 'ศุกร์ 20 พ.ย.', '20/11 ศุกร์', 'วันที่ 20 ศุกร์', 'Fri 20 Nov',
    'พรุ่งนี้ส่ง ส่วนศุกร์ประชุม', 'มะรืนนะ ไม่ใช่ศุกร์', 'พุธประชุม ศุกร์ส่ง', 'ก่อนวันศุกร์', 'ส่งอาทิตย์หน้า', 'อาทิตย์นี้',
  ])('%j gives no weekday to act on', (text) => {
    expect(findWeekday(text)).toBeNull()
  })

  it('never reads a short form inside another word', () => {
    for (const text of ['ไปศึกษาเพิ่ม', 'สั่งอาหาร', 'ถามอาจารย์', 'เดือนพฤศจิกายน', 'พฤษภาคม', 'ศ.ดร.สมชาย', 'รายงานปี พ.ศ. 2569', 'ค.ศ. 2026', 'I sat on the sun']) {
      expect(findWeekday(text)).toBeNull()
    }
  })

  it('a tagged name that is a day word is a person, not a weekday', () => {
    expect(findWeekday('ฝาก @อาทิตย์ ส่งวันพฤหัส')).toEqual({ weekday: 4, nextWeek: false })
    expect(findWeekday('@Sun ส่ง Fri')).toEqual({ weekday: 5, nextWeek: false })
  })

  it('reads หน้า as next week only right at the day, not "10 หน้า" pages', () => {
    expect(findWeekday('สไลด์ 10 หน้า ส่งวันศุกร์')).toEqual({ weekday: 5, nextWeek: false })
  })
})

describe('bangkokWeekdayDate', () => {
  // Tuesday 17 Nov 2026, 13:30 in Bangkok.
  const now = new Date('2026-11-17T06:30:00Z')
  it('is the first such day on or after today', () => {
    expect(bangkokWeekdayDate(now, 4, false)).toBe('2026-11-19')
    expect(bangkokWeekdayDate(now, 2, false)).toBe('2026-11-17')
    expect(bangkokWeekdayDate(now, 1, false)).toBe('2026-11-23')
  })
  it('is that day of the following Monday-start week for หน้า', () => {
    expect(bangkokWeekdayDate(now, 4, true)).toBe('2026-11-26')
    expect(bangkokWeekdayDate(now, 1, true)).toBe('2026-11-23')
    // On a Sunday, the following week starts tomorrow.
    expect(bangkokWeekdayDate(new Date('2026-11-22T03:00:00Z'), 5, true)).toBe('2026-11-27')
  })
})
