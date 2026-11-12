// Asia/Bangkok time as a fixed UTC+7 shift (Bangkok has no DST). No Intl, so output
// is deterministic. The month rule matches the DB view owner_monthly_usage
// (date_trunc('month', created_at at time zone 'Asia/Bangkok')).

export const BKK_OFFSET_MS = 7 * 3600_000

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const THAI_MONTHS_LONG = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Bangkok wall-clock parts; m is 1..12. */
export function bangkokParts(d: Date): { y: number; m: number; d: number; hh: number; mm: number } {
  const s = new Date(d.getTime() + BKK_OFFSET_MS)
  return { y: s.getUTCFullYear(), m: s.getUTCMonth() + 1, d: s.getUTCDate(), hh: s.getUTCHours(), mm: s.getUTCMinutes() }
}

/** '2026-11-12 09:15' */
export function formatPromptTime(d: Date): string {
  const p = bangkokParts(d)
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`
}

/** '12 พ.ย. 09:15' */
export function formatThaiShort(d: Date): string {
  const p = bangkokParts(d)
  return `${p.d} ${THAI_MONTHS_SHORT[p.m - 1]} ${pad(p.hh)}:${pad(p.mm)}`
}

/** '1 ธันวาคม 2569' (Buddhist year = y + 543) */
export function formatThaiDateLong(d: Date): string {
  const p = bangkokParts(d)
  return `${p.d} ${THAI_MONTHS_LONG[p.m - 1]} ${p.y + 543}`
}

/** The Bangkok calendar month holding `now`: start (1st 00:00 BKK) and end (next 1st)
 *  as UTC instants, and the month start label 'YYYY-MM-01'. */
export function bangkokMonthRange(now: Date): { start: Date; end: Date; monthStartBkk: string } {
  const { y, m } = bangkokParts(now)
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - BKK_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - BKK_OFFSET_MS),
    monthStartBkk: `${y}-${pad(m)}-01`,
  }
}

/** '2026-11-12' */
export function bangkokTodayLabel(now: Date): string {
  const p = bangkokParts(now)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** ISO weekday in Bangkok: 1 = Monday ... 7 = Sunday, the same numbering as
 *  groups.weekly_summary_weekday. */
export function bangkokIsoWeekday(now: Date): number {
  const day = new Date(now.getTime() + BKK_OFFSET_MS).getUTCDay()
  return day === 0 ? 7 : day
}

/** Monday of the Bangkok week holding `now`, as 'YYYY-MM-DD' (weekly_insights.week_start). */
export function bangkokWeekStartLabel(now: Date): string {
  return bangkokTodayLabel(new Date(now.getTime() - (bangkokIsoWeekday(now) - 1) * 86_400_000))
}

/** Minutes after midnight of a Postgres `time` value, 'HH:MM' or 'HH:MM:SS'. */
export function parseTimeOfDay(time: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!match) throw new Error('time of day must be HH:MM or HH:MM:SS')
  const hh = Number(match[1])
  const mm = Number(match[2])
  if (hh > 23 || mm > 59) throw new Error('time of day out of range')
  return hh * 60 + mm
}

/** A group's daily slot: its chosen Bangkok time and the Bangkok date it was last sent
 *  ('YYYY-MM-DD', groups.daily_reminder_last_sent_on), or null if never sent. */
export type DailySlot = { time: string; lastSentOn: string | null }

/** A group's weekly slot: its chosen ISO weekday and Bangkok time, and the Bangkok date it
 *  was last sent (groups.weekly_summary_last_sent_on). */
export type WeeklySlot = DailySlot & { weekday: number }

/** Due on the first tick at or after the chosen time, once per Bangkok day. A time
 *  changed later the same day does not send again, because the date already matches.
 *  Being due is not a claim: the caller still claims the slot in the database before
 *  sending, so two overlapping ticks cannot both send. */
export function isDailyDue(slot: DailySlot, now: Date): boolean {
  if (slot.lastSentOn !== null && slot.lastSentOn >= bangkokTodayLabel(now)) return false
  const p = bangkokParts(now)
  return p.hh * 60 + p.mm >= parseTimeOfDay(slot.time)
}

/** Due on the chosen weekday, on the first tick at or after the chosen time, once per
 *  Bangkok day. A day whose ticks all fail is not caught up later in the week. */
export function isWeeklyDue(slot: WeeklySlot, now: Date): boolean {
  return bangkokIsoWeekday(now) === slot.weekday && isDailyDue(slot, now)
}
