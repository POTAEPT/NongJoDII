import type { StorePort, TaskStatus } from '../ports'

// Task field rules shared by the review submit (#16) and the Task edit (#5).

export type TaskFieldsInput = { title: unknown; details: unknown; assigneeLineUserId: unknown; dueAt: unknown }
export type TaskFields = { title: string; details: string | null; assigneeLineUserId: string | null; dueAt: Date | null }
export type TaskField = 'title' | 'details' | 'dueAt' | 'assigneeLineUserId'

const TITLE_MAX = 200
const DETAILS_MAX = 2000

/** title.trim() 1..200 chars; details null or string <= 2000 (empty after trim -> null);
 *  dueAt null or a string that parses to a valid Date; assignee null or a live Member
 *  of groupId (store.getMembership === 'live'). First failing field is returned. */
export async function validateTaskFields(
  store: StorePort,
  groupId: string,
  input: TaskFieldsInput,
): Promise<{ ok: true; fields: TaskFields } | { ok: false; field: TaskField }> {
  if (typeof input.title !== 'string') return { ok: false, field: 'title' }
  const title = input.title.trim()
  if (title.length < 1 || title.length > TITLE_MAX) return { ok: false, field: 'title' }

  let details: string | null = null
  if (input.details !== null) {
    if (typeof input.details !== 'string') return { ok: false, field: 'details' }
    const trimmed = input.details.trim()
    if (trimmed.length > DETAILS_MAX) return { ok: false, field: 'details' }
    details = trimmed === '' ? null : trimmed
  }

  let dueAt: Date | null = null
  if (input.dueAt !== null) {
    if (typeof input.dueAt !== 'string') return { ok: false, field: 'dueAt' }
    dueAt = new Date(input.dueAt)
    if (Number.isNaN(dueAt.getTime())) return { ok: false, field: 'dueAt' }
  }

  let assigneeLineUserId: string | null = null
  if (input.assigneeLineUserId !== null) {
    const a = input.assigneeLineUserId
    if (typeof a !== 'string' || a === '' || (await store.getMembership(groupId, a)) !== 'live') {
      return { ok: false, field: 'assigneeLineUserId' }
    }
    assigneeLineUserId = a
  }

  return { ok: true, fields: { title, details, assigneeLineUserId, dueAt } }
}

/** D13: done stays done; otherwise an assignee gives 'in_process', none gives 'not_assigned'. */
export function statusFor(assigneeLineUserId: string | null, current: TaskStatus | null): TaskStatus {
  if (current === 'done') return 'done'
  return assigneeLineUserId === null ? 'not_assigned' : 'in_process'
}
