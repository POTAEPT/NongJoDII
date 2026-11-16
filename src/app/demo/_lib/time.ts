// Demo-clock display in Asia/Bangkok. Thai labels with Gregorian years (no Buddhist era).
const TZ = 'Asia/Bangkok'
const WEEKDAYS = ['วันอาทิตย์', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์']
const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

type Parts = { y: number; m: number; d: number; hh: string; mm: string; ss: string; weekday: number }

function parts(iso: string): Parts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(new Date(iso))
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? ''
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), hh: get('hour'), mm: get('minute'), ss: get('second'), weekday: wd }
}

/** 'YYYY-MM-DD' in Bangkok. */
export function bangkokDate(iso: string): string {
  const p = parts(iso)
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}

/** '14:05' in Bangkok. */
export function timeLabel(iso: string): string {
  const p = parts(iso)
  return `${p.hh}:${p.mm}`
}

export function clockLabel(iso: string): { time: string; seconds: string; date: string } {
  const p = parts(iso)
  return { time: `${p.hh}:${p.mm}`, seconds: p.ss, date: `${WEEKDAYS[p.weekday]} ${p.d} ${MONTHS[p.m - 1]} ${p.y}` }
}

/** The chat's date separator: วันนี้ / เมื่อวาน / "วันจันทร์ 16 พ.ย.", against the demo clock. */
export function dateSeparator(iso: string, nowIso: string): string {
  const day = bangkokDate(iso)
  const today = bangkokDate(nowIso)
  if (day === today) return 'วันนี้'
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000)
  if (diff === 1) return 'เมื่อวาน'
  const p = parts(iso)
  return `${WEEKDAYS[p.weekday]} ${p.d} ${MONTHS[p.m - 1]}${p.y !== parts(nowIso).y ? ` ${p.y}` : ''}`
}

/** A local calendar Date for a 'YYYY-MM-DD' string (no UTC shift). */
export function dateFromYmd(ymd: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 'YYYY-MM-DD' of a local calendar Date (what react-day-picker hands back). */
export function ymdFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
