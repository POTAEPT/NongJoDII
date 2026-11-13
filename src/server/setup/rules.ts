// Limits and defaults of the setup form (#52, Figma v4 #2b-#2d2). Pure: the LIFF form
// (src/app/liff/setup-model.ts) and the server checks (submit.ts) share them.

/** groups.work_description CHECK (char_length <= 2000). */
export const WORK_DESCRIPTION_MAX = 2000
/** Agent choices: room for real nicknames and roles, small enough for the AI prompt. */
export const NICKNAME_MAX = 50
export const NICKNAMES_PER_MEMBER_MAX = 10
export const ROLE_MAX = 100
/** Most Members one form may list (a LINE group holds at most 500 people). */
export const MEMBERS_MAX = 500

/** The schema defaults the form is prefilled with: daily 09:00, weekly Monday 09:00
 *  (Asia/Bangkok), every feature on. */
export const SETUP_DEFAULTS = {
  dailyReminderTime: '09:00',
  weeklySummaryWeekday: 1,
  weeklySummaryTime: '09:00',
} as const

const QUARTER_HOUR = /^([01]\d|2[0-3]):(00|15|30|45)$/

/** 'HH:MM' on a quarter hour: the 15-minute tick can hit it exactly (groups CHECKs). */
export function isQuarterHour(time: unknown): time is string {
  return typeof time === 'string' && QUARTER_HOUR.test(time)
}

/** Every pickable time, '00:00' ... '23:45'. */
export const QUARTER_HOURS: readonly string[] = Array.from({ length: 96 }, (_, i) => {
  const hh = String(Math.floor(i / 4)).padStart(2, '0')
  const mm = String((i % 4) * 15).padStart(2, '0')
  return `${hh}:${mm}`
})

/** ISO weekdays with the chip labels of #2d2, Monday first. */
export const WEEKDAYS: readonly { iso: number; label: string }[] = [
  { iso: 1, label: 'จ' }, { iso: 2, label: 'อ' }, { iso: 3, label: 'พ' }, { iso: 4, label: 'พฤ' },
  { iso: 5, label: 'ศ' }, { iso: 6, label: 'ส' }, { iso: 7, label: 'อา' },
]

export function isIsoWeekday(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 7
}

/** Trimmed, empty ones dropped, duplicates removed (first spelling kept). */
export function cleanNicknames(names: string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const n = raw.trim()
    if (n !== '' && !out.includes(n)) out.push(n)
  }
  return out
}
