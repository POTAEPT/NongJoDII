// Postback data of the daily reminder buttons (#44 sends them, #45 answers them).
// IDs and dates only (rules: Baseline). The `a` codes differ from the progress cards' (pg, pw,
// pk, px in progress/postback.ts), whose parser ignores any code it does not know.

export type ReminderAction =
  | { kind: 'done'; taskId: string }                       // "เสร็จแล้ว"
  | { kind: 'postpone'; taskId: string }                   // "เลื่อนกำหนด": replies with the choices
  | { kind: 'postpone_to'; taskId: string; date: string }  // a choice: +1 day, +3 days, +1 week ('YYYY-MM-DD')
  | { kind: 'postpone_pick'; taskId: string }              // "เลือกวันเอง": the date comes from the picker
  | { kind: 'take'; taskId: string }                       // "ฉันรับเอง" on a Task with no owner

const CODE = { done: 'rd', postpone: 'rp', postpone_to: 'rpt', postpone_pick: 'rpc', take: 'rt' } as const
const KIND_OF: Record<string, ReminderAction['kind']> = Object.fromEntries(
  Object.entries(CODE).map(([kind, code]) => [code, kind as ReminderAction['kind']]),
)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export function encodeReminderAction(action: ReminderAction): string {
  const p = new URLSearchParams({ a: CODE[action.kind], t: action.taskId })
  if (action.kind === 'postpone_to') p.set('d', action.date)
  return p.toString()
}

/** null = not a reminder button (another feature's postback, or malformed). */
export function parseReminderAction(data: string): ReminderAction | null {
  const p = new URLSearchParams(data)
  const kind = KIND_OF[p.get('a') ?? '']
  const taskId = p.get('t')
  if (!kind || !taskId || !UUID.test(taskId)) return null
  if (kind === 'postpone_to') {
    const date = p.get('d')
    return date && ISO_DATE.test(date) ? { kind, taskId, date } : null
  }
  return { kind, taskId }
}
