import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { badRequest, field } from '../review/load'
import { statusFor, validateTaskFields } from './fields'
import { openTask, taskView } from './load'

/** POST /api/tasks/update. lastEditedByLineUserId is always the verified user. */
export async function updateTaskFromLiff(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openTask(deps, body)
  if (!gate.ok) return gate.result
  const { task, requester } = gate
  const v = await validateTaskFields(deps.store, task.groupId, {
    title: field(body, 'title'), details: field(body, 'details'),
    assigneeLineUserId: field(body, 'assigneeLineUserId'), dueAt: field(body, 'dueAt'),
  })
  if (!v.ok) return badRequest(v.field)
  const status = statusFor(v.fields.assigneeLineUserId, task.status)
  const { updated } = await deps.store.updateTask(task.id, {
    ...v.fields, status, lastEditedByLineUserId: requester, lastActivityAt: deps.now(),
  })
  // Deleted between the gate and the write: nothing was changed.
  if (!updated) return { status: 404, body: { error: 'not_found' } }
  log('task_edited', { taskId: task.id })
  // #29: the assignee may have left the group after validateTaskFields read them as live. A
  // leave marks the person left before it releases their Tasks (webhook/ingest.ts), so a write
  // that landed after the release always sees 'left' here, and one before it was released.
  const assignee = v.fields.assigneeLineUserId
  if (assignee !== null && (await deps.store.getMembership(task.groupId, assignee)) !== 'live') {
    await deps.store.releaseTasksOf({ groupId: task.groupId, lineUserId: assignee })
    log('task_edit_assignee_left', { taskId: task.id })
  }
  const fresh = (await deps.store.getTask(task.id)) ?? task
  return { status: 200, body: await taskView(deps, fresh) }
}
