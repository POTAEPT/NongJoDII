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
