// Postback data of the daily reminder buttons (#44 sends them, #45 answers them).
// IDs only (rules: Baseline). The `a` codes differ from the progress cards' (pg, pw, pk,
// px in progress/postback.ts), whose parser ignores any code it does not know.

export type ReminderAction =
  | { kind: 'done'; taskId: string }       // "เสร็จแล้ว"
  | { kind: 'postpone'; taskId: string }   // "ขอเลื่อน": #45 replies with the choices (tomorrow, 3 days, next week)

const CODE = { done: 'rd', postpone: 'rp' } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeReminderAction(action: ReminderAction): string {
  return new URLSearchParams({ a: CODE[action.kind], t: action.taskId }).toString()
}

/** null = not a reminder button (another feature's postback, or malformed). */
export function parseReminderAction(data: string): ReminderAction | null {
  const p = new URLSearchParams(data)
  const taskId = p.get('t')
  if (!taskId || !UUID.test(taskId)) return null
  if (p.get('a') === CODE.done) return { kind: 'done', taskId }
  if (p.get('a') === CODE.postpone) return { kind: 'postpone', taskId }
  return null
}
