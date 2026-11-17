// Asia/Bangkok time as a fixed UTC+7 shift (Bangkok has no DST). No Intl, so output
// is deterministic. The month rule matches the DB view owner_monthly_usage
// (date_trunc('month', created_at at time zone 'Asia/Bangkok')).

export const BKK_OFFSET_MS = 7 * 3600_000

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const THAI_MONTHS_LONG = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]

/** ISO weekday 1..7 (Monday first). */
export const THAI_WEEKDAY_SHORT = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']

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

/** The one date-and-time style of the cards (UX review 4.2): 'พฤ. 12 พ.ย. 09:15'. The
 *  weekday is there because people plan work by day ("ส่งวันพฤหัส"). */
export function formatThaiShort(d: Date): string {
  return `${formatThaiWeekdayDay(d)} ${formatHhmm(d)}`
}

/** 'พฤ. 12 พ.ย.' */
export function formatThaiWeekdayDay(d: Date): string {
  return `${THAI_WEEKDAY_SHORT[bangkokIsoWeekday(d) - 1]} ${formatThaiDayMonth(d)}`
}

/** '09:15' */
export function formatHhmm(d: Date): string {
  const p = bangkokParts(d)
  return `${pad(p.hh)}:${pad(p.mm)}`
}

/** UX review 4.3, for cards about today (the daily reminder): 'วันนี้ 17:00',
 *  'พรุ่งนี้ 09:00', 'เมื่อวาน 17:00', otherwise formatThaiShort. Not for cards people read
 *  days later, where "วันนี้" would turn wrong. */
export function formatRelativeDue(d: Date, now: Date): string {
  const day = (x: Date) => Math.floor((x.getTime() + BKK_OFFSET_MS) / 86_400_000)
  const diff = day(d) - day(now)
  if (diff === 0) return `วันนี้ ${formatHhmm(d)}`
  if (diff === 1) return `พรุ่งนี้ ${formatHhmm(d)}`
  if (diff === -1) return `เมื่อวาน ${formatHhmm(d)}`
  return formatThaiShort(d)
}

/** '16 พ.ย.' */
export function formatThaiDayMonth(d: Date): string {
  const p = bangkokParts(d)
  return `${p.d} ${THAI_MONTHS_SHORT[p.m - 1]}`
}

/** The Bangkok week starting on `weekStart` ('YYYY-MM-DD', a Monday): '16–22 พ.ย.', or
 *  '30 พ.ย. – 6 ธ.ค.' when it crosses a month. */
export function formatThaiWeekRange(weekStart: string): string {
  const start = new Date(`${weekStart}T00:00:00+07:00`)
  const end = new Date(start.getTime() + 6 * 86_400_000)
  const s = bangkokParts(start)
  const e = bangkokParts(end)
  return s.m === e.m ? `${s.d}–${e.d} ${THAI_MONTHS_SHORT[e.m - 1]}` : `${formatThaiDayMonth(start)} – ${formatThaiDayMonth(end)}`
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

/** 23:59 Bangkok on the Bangkok day of `d`: the due of a deadline that names a day but no
 *  time, the same instant the LIFF form saves for a date with the time left blank. */
export function bangkokEndOfDay(d: Date): Date {
  return new Date(`${bangkokTodayLabel(d)}T23:59:00+07:00`)
}

/** '2026-11-12' */
export function bangkokTodayLabel(now: Date): string {
  const p = bangkokParts(now)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

const WEEKDAY_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] // ISO 1..7
const THAI_WEEKDAY_LONG = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'] // ISO 1..7
const WEEK_TAG = ['this week', 'next week (สัปดาห์หน้า)', 'later']

/** #161: today and the next `days` days in Bangkok, one line each, for the Summary prompt:
 *  '- 2026-11-19 Thu พฤหัสบดี (พฤ.) this week'. A model given only the date cannot tell which
 *  day "ศุกร์นี้" is, and Thai chat names days in Thai ("ส่งวันพฤหัส"), so each line carries the
 *  Thai name and short form too; today and tomorrow are marked วันนี้ and พรุ่งนี้, and each day
 *  says whether it is in this week or the next (weeks start on Monday). Bangkok has no
 *  daylight saving, so whole days of 24 hours are exact. */
export function bangkokCalendar(now: Date, days = 14): string[] {
  const todayIso = bangkokIsoWeekday(now)
  return Array.from({ length: days + 1 }, (_, i) => {
    const d = new Date(now.getTime() + i * 86_400_000)
    const wd = bangkokIsoWeekday(d)
    const week = WEEK_TAG[Math.min(2, Math.floor((i + todayIso - 1) / 7))]
    const mark = i === 0 ? ', วันนี้ (today)' : i === 1 ? ', พรุ่งนี้ (tomorrow)' : ''
    return `- ${bangkokTodayLabel(d)} ${WEEKDAY_EN[wd - 1]} ${THAI_WEEKDAY_LONG[wd - 1]} (${THAI_WEEKDAY_SHORT[wd - 1]}) ${week}${mark}`
  })
}

// ---- Weekday words in chat (the Summary's due check) ----

const TH = '\u0E00-\u0E7F'
// Longest first, so "พฤหัสบดี" wins over "พฤหัส" and "พฤ", and "อาทิตย์" over "อา".
const THAI_DAY_LONG: [string, number][] = [
  ['จันทร์', 1], ['อังคาร', 2], ['พุธ', 3], ['พฤหัสบดี', 4], ['พฤหัส', 4], ['ศุกร์', 5], ['เสาร์', 6], ['อาทิตย์', 7],
]
const THAI_DAY_SHORT: [string, number][] = [['พฤ', 4], ['ศ', 5], ['อา', 7]]
const EN_DAY: [string, number][] = [
  ['monday', 1], ['tuesday', 2], ['wednesday', 3], ['thursday', 4], ['friday', 5], ['saturday', 6], ['sunday', 7],
  ['mon', 1], ['tues', 2], ['tue', 2], ['wed', 3], ['thurs', 4], ['thur', 4], ['thu', 4], ['fri', 5], ['sat', 6], ['sun', 7],
]
const DAY_BY_WORD = new Map<string, number>([...THAI_DAY_LONG, ...THAI_DAY_SHORT, ...EN_DAY])
// A short form ("พฤ", "ศ", "อา") is a day only on its own: after "วัน", the start, or a
// non-Thai character, and before "นี้" / "หน้า", the end, or a non-Thai character (one dot
// allowed). So "ศึกษา", "อาหาร", "อาจารย์", "พฤศจิกายน" and "ศ.ดร." are not days.
const SHORT = String.raw`(?:(?<=วัน)|(?<![${TH}]))(?:${THAI_DAY_SHORT.map(([w]) => w).join('|')})(?=\.?(?:\s*(?:หน้า|นี้)|$|[^${TH}.]))`
const DAY_WORD = new RegExp(
  String.raw`(?:${THAI_DAY_LONG.map(([w]) => w).join('|')})|${SHORT}|(?<![A-Za-z])(?:${EN_DAY.map(([w]) => w).join('|')})(?![A-Za-z])`,
  'gi',
)
const EN_DAY_ALT = EN_DAY.map(([w]) => w).join('|')
// Next week: "สัปดาห์หน้า", "อาทิตย์หน้า" (bare อาทิตย์ is "week"), "next week", or หน้า / next
// right at a day word ("พฤหัสหน้า", "next Fri").
const NEXT_WEEK = /สัปดาห์หน้า|(?<!วัน)อาทิตย์\s*หน้า|week\s*หน้า|next\s+week/i
// Another day word that points away from the weekday: the weekday is then left to the model.
const OTHER_DAY = new RegExp(
  String.raw`วันนี้|คืนนี้|เย็นนี้|พรุ่ง|มะรืน|เมื่อวาน|ที่แล้ว|\b(?:today|tonight|tomorrow|yesterday)\b|\blast\s+(?:week|${EN_DAY_ALT})\b`, 'i',
)

const THAI_MONTH = [...THAI_MONTHS_LONG, ...THAI_MONTHS_SHORT.map((m) => m.replace(/\./g, '\\.?'))].join('|')
const EN_MONTH = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec'
const DIGIT = '[0-9๐-๙]'
// A date written out: "20 พ.ย.", "20 พฤศจิกายน", "20 Nov", "Nov 20", "20/11", "วันที่ 20".
const EXPLICIT_DATE = new RegExp(
  String.raw`${DIGIT}{1,2}\s*(?:${THAI_MONTH})|${DIGIT}{1,2}\s*(?:${EN_MONTH})[a-z]*\b|\b(?:${EN_MONTH})[a-z]*\.?\s*${DIGIT}{1,2}(?!${DIGIT})|${DIGIT}{1,2}\s*/\s*${DIGIT}{1,2}|วันที่\s*${DIGIT}`,
  'i',
)

/** The one weekday a chat message names ("ส่งวันพฤหัส", "ศุกร์นี้ห้าโมงเย็น", "Fri"), 1..7 (ISO),
 *  and whether it is in the following week ("พฤหัสหน้า", "สัปดาห์หน้า", "next week", "next Fri").
 *  Null when the text names no weekday or two different ones, writes a date out ("20 พ.ย.",
 *  "20/11"), names another day (พรุ่งนี้, มะรืน, วันนี้, ที่แล้ว), or puts ก่อน / หลัง / before /
 *  after in front of the weekday. Bare "อาทิตย์" before หน้า / นี้ / ที่แล้ว is "week", not Sunday. */
export function findWeekday(text: string): { weekday: number; nextWeek: boolean } | null {
  if (EXPLICIT_DATE.test(text) || OTHER_DAY.test(text)) return null
  const days = new Set<number>()
  let nextWeek = NEXT_WEEK.test(text)
  for (const m of text.matchAll(DAY_WORD)) {
    const word = m[0]
    const before = text.slice(0, m.index)
    const after = text.slice(m.index + word.length)
    // English short forms only when capitalized ("Fri", "SAT"), so "I sat" or "the sun" are no days.
    if (/^[a-z]{3,5}$/.test(word)) continue
    if (word === 'อาทิตย์' && !before.endsWith('วัน') && /^\s*(?:หน้า|นี้|ที่แล้ว|ก่อน)/.test(after)) continue
    const day = DAY_BY_WORD.get(word.toLowerCase())
    if (day === undefined) continue
    // "ก่อนวันศุกร์", "หลังวันจันทร์", "before Fri": a day around the weekday, not on it.
    if (/(?:ก่อน|หลัง|\bbefore|\bafter)\s*(?:วัน)?\s*$/i.test(before)) return null
    days.add(day)
    if (/^\.?\s*หน้า/.test(after) || /\bnext\s+$/i.test(before)) nextWeek = true
  }
  return days.size === 1 ? { weekday: [...days][0], nextWeek } : null
}

/** The Bangkok date ('YYYY-MM-DD') a weekday word means, as the Summary prompt teaches (#161):
 *  the first such day on or after today, or, for the following week, that day in the week
 *  after this one (weeks start on Monday). */
export function bangkokWeekdayDate(now: Date, weekday: number, nextWeek: boolean): string {
  const today = bangkokIsoWeekday(now)
  const offset = nextWeek ? 7 - today + weekday : (weekday - today + 7) % 7
  return bangkokTodayLabel(new Date(now.getTime() + offset * 86_400_000))
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
