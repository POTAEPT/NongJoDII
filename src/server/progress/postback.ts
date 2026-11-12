import type { ProgressTarget } from '../ports'

// Postback data of the progress cards (#7). IDs only, never Task titles or chat text
// (rules: routes and logs carry IDs only). LINE caps postback data at 300 characters.

export type ProgressAction =
  | { kind: 'answer'; promptId: string; answer: 'yes' | 'no' }                          // "อัปเดตงานนี้ไหม?" Yes / No
  | { kind: 'wrong_task'; promptId: string }                                            // "ผิดงาน · เลือกงานอื่น"
  | { kind: 'pick'; messageId: string; taskId: string; targetStatus: ProgressTarget }   // a Task on the picker
  | { kind: 'not_update'; messageId: string }                                           // "ไม่ใช่การอัปเดตงาน"

const STATUS_CODE: Record<ProgressTarget, string> = { done: 'd', in_process: 'i' }

export function encodeProgressAction(action: ProgressAction): string {
  const p = new URLSearchParams()
  switch (action.kind) {
    case 'answer':
      p.set('a', 'pg')
      p.set('p', action.promptId)
      p.set('v', action.answer === 'yes' ? 'y' : 'n')
      break
    case 'wrong_task':
      p.set('a', 'pw')
      p.set('p', action.promptId)
      break
    case 'pick':
      p.set('a', 'pk')
      p.set('m', action.messageId)
      p.set('t', action.taskId)
      p.set('s', STATUS_CODE[action.targetStatus])
      break
    case 'not_update':
      p.set('a', 'px')
      p.set('m', action.messageId)
      break
  }
  return p.toString()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** null for data that is not a progress postback, or is malformed. Every ID must be a
 *  UUID: postback data comes from the client, and Postgres rejects a malformed uuid. */
export function parseProgressAction(data: string): ProgressAction | null {
  const p = new URLSearchParams(data)
  const get = (k: string) => {
    const v = p.get(k)
    return v && (k === 'v' || k === 's' || UUID.test(v)) ? v : null
  }
  switch (p.get('a')) {
    case 'pg': {
      const promptId = get('p')
      const v = get('v')
      if (!promptId || (v !== 'y' && v !== 'n')) return null
      return { kind: 'answer', promptId, answer: v === 'y' ? 'yes' : 'no' }
    }
    case 'pw': {
      const promptId = get('p')
      return promptId ? { kind: 'wrong_task', promptId } : null
    }
    case 'pk': {
      const messageId = get('m')
      const taskId = get('t')
      const s = get('s')
      if (!messageId || !taskId || (s !== 'd' && s !== 'i')) return null
      return { kind: 'pick', messageId, taskId, targetStatus: s === 'd' ? 'done' : 'in_process' }
    }
    case 'px': {
      const messageId = get('m')
      return messageId ? { kind: 'not_update', messageId } : null
    }
    default:
      return null
  }
}
