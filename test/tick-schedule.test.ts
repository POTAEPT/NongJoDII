import { describe, expect, it } from 'vitest'
import {
  bangkokIsoWeekday,
  bangkokWeekStartLabel,
  isDailyDue,
  isWeeklyDue,
  parseTimeOfDay,
} from '@/server/time/bangkok'

/** A Bangkok wall-clock time as the UTC instant the server sees. */
const bkk = (s: string) => new Date(`${s}+07:00`)

describe('parseTimeOfDay', () => {
  it('reads HH:MM and the HH:MM:SS that Postgres returns', () => {
    expect(parseTimeOfDay('09:00')).toBe(540)
    expect(parseTimeOfDay('09:15:00')).toBe(555)
    expect(parseTimeOfDay('00:00')).toBe(0)
    expect(parseTimeOfDay('23:45:00')).toBe(1425)
  })

  it('rejects anything else', () => {
    expect(() => parseTimeOfDay('9:00')).toThrow()
    expect(() => parseTimeOfDay('24:00')).toThrow()
    expect(() => parseTimeOfDay('09:60')).toThrow()
    expect(() => parseTimeOfDay('')).toThrow()
  })
})

describe('bangkokIsoWeekday and bangkokWeekStartLabel', () => {
  it('numbers Monday 1 to Sunday 7 in Bangkok time', () => {
    expect(bangkokIsoWeekday(bkk('2026-11-16T00:00:00'))).toBe(1) // Monday
    expect(bangkokIsoWeekday(bkk('2026-11-22T23:59:00'))).toBe(7) // Sunday
  })

  it('uses the Bangkok day, not the UTC day', () => {
    // Sunday 23:30 UTC is already Monday 06:30 in Bangkok.
    expect(bangkokIsoWeekday(new Date('2026-11-15T23:30:00Z'))).toBe(1)
  })

  it('gives the Monday of the Bangkok week', () => {
    expect(bangkokWeekStartLabel(bkk('2026-11-16T09:00:00'))).toBe('2026-11-16')
    expect(bangkokWeekStartLabel(bkk('2026-11-22T23:59:00'))).toBe('2026-11-16')
    expect(bangkokWeekStartLabel(bkk('2026-12-02T10:00:00'))).toBe('2026-11-30') // across a month
  })
})

describe('isDailyDue', () => {
  const slot = (time: string, lastSentOn: string | null = null) => ({ time, lastSentOn })

  it('is not due before the chosen time', () => {
    expect(isDailyDue(slot('09:00:00'), bkk('2026-11-16T08:45:00'))).toBe(false)
  })

  it('is due on the tick at the chosen time and on later ticks the same day', () => {
    expect(isDailyDue(slot('09:00:00'), bkk('2026-11-16T09:00:00'))).toBe(true)
    expect(isDailyDue(slot('09:00:00'), bkk('2026-11-16T09:15:00'))).toBe(true)
    // A tick that arrives a few minutes late still counts.
    expect(isDailyDue(slot('09:00:00'), bkk('2026-11-16T09:03:12'))).toBe(true)
  })

  it('is not due again once sent today', () => {
    expect(isDailyDue(slot('09:00:00', '2026-11-16'), bkk('2026-11-16T09:15:00'))).toBe(false)
  })

  it('is due again the next day', () => {
    expect(isDailyDue(slot('09:00:00', '2026-11-16'), bkk('2026-11-17T09:00:00'))).toBe(true)
  })

  it('follows a time changed in Settings', () => {
    // Moved from 09:00 to 13:30 before today's send: due at 13:30, not 09:00.
    expect(isDailyDue(slot('13:30:00', '2026-11-15'), bkk('2026-11-16T09:00:00'))).toBe(false)
    expect(isDailyDue(slot('13:30:00', '2026-11-15'), bkk('2026-11-16T13:30:00'))).toBe(true)
  })

  it('does not send twice when the time is moved later after today\'s send', () => {
    expect(isDailyDue(slot('17:00:00', '2026-11-16'), bkk('2026-11-16T17:00:00'))).toBe(false)
  })

  it('uses the Bangkok date for "today"', () => {
    // 23:45 Bangkok on the 16th is 16:45 UTC the same day; 00:15 on the 17th is 17:15 UTC on the 16th.
    expect(isDailyDue(slot('23:45:00', '2026-11-15'), bkk('2026-11-16T23:45:00'))).toBe(true)
    expect(isDailyDue(slot('00:00:00', '2026-11-16'), bkk('2026-11-17T00:15:00'))).toBe(true)
  })
})

describe('isWeeklyDue', () => {
  const monday9 = { weekday: 1, time: '09:00:00', lastSentOn: null as string | null }

  it('is due on the chosen weekday at or after the chosen time', () => {
    expect(isWeeklyDue(monday9, bkk('2026-11-16T08:45:00'))).toBe(false)
    expect(isWeeklyDue(monday9, bkk('2026-11-16T09:00:00'))).toBe(true)
  })

  it('is not due on another weekday', () => {
    expect(isWeeklyDue(monday9, bkk('2026-11-17T09:00:00'))).toBe(false)
  })

  it('is not due twice in the same day', () => {
    expect(isWeeklyDue({ ...monday9, lastSentOn: '2026-11-16' }, bkk('2026-11-16T10:00:00'))).toBe(false)
  })

  it('is due again the next week', () => {
    expect(isWeeklyDue({ ...monday9, lastSentOn: '2026-11-16' }, bkk('2026-11-23T09:00:00'))).toBe(true)
  })

  it('follows a non-default day and time', () => {
    const friday1630 = { weekday: 5, time: '16:30:00', lastSentOn: null }
    expect(isWeeklyDue(friday1630, bkk('2026-11-20T16:15:00'))).toBe(false)
    expect(isWeeklyDue(friday1630, bkk('2026-11-20T16:30:00'))).toBe(true)
    expect(isWeeklyDue(friday1630, bkk('2026-11-16T16:30:00'))).toBe(false)
  })
})
