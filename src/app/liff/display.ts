// Pure display helpers for the LIFF pages (Figma UI v4), kept out of the views so
// they can be tested without a DOM.

const LEADING_VOWELS = new Set(['เ', 'แ', 'โ', 'ใ', 'ไ'])

/** The letter shown in a Member's avatar: the first character of the LINE name,
 *  skipping Thai leading vowels (เจฟ → จ), so it reads like the Figma Avatar. */
export function avatarInitial(name: string): string {
  const chars = Array.from(name.trim())
  const first = chars.find((c) => !LEADING_VOWELS.has(c)) ?? chars[0]
  return first ? first.toUpperCase() : '?'
}

/** Avatar colour pairs from the design system, picked by a stable hash of the key. */
export const AVATAR_TONES = [
  'bg-primary-soft text-primary',
  'bg-done-bg text-done',
  'bg-warn-bg text-warn',
  'bg-line text-ink',
] as const

export function avatarTone(key: string): (typeof AVATAR_TONES)[number] {
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

const WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const DAY_MS = 24 * 60 * 60 * 1000

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS)
}

/** Due chip text: "วันนี้ 17:00", "พรุ่งนี้ 13:00", "พฤ. 12 พ.ย. 16:00", or null when
 *  there is no due date ("ยังไม่กำหนด" in the chip). `date` is 'YYYY-MM-DD' and
 *  `today` is Bangkok's date in the same form. */
export function dueLabel(date: string, time: string, today: string): string | null {
  if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null
  const diff = dayNumber(date) - dayNumber(today)
  let day: string
  if (diff === 0) day = 'วันนี้'
  else if (diff === 1) day = 'พรุ่งนี้'
  else {
    const d = new Date(`${date}T00:00:00Z`)
    day = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
  }
  return time ? `${day} ${time}` : day
}

/** Today's date in Bangkok as 'YYYY-MM-DD' (fixed UTC+7, no DST). */
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
