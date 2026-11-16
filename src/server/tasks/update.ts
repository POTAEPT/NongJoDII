import { log } from '../log'
import { releaseIfLeft } from '../members/recheck'
import type { ApiResult, Deps } from '../ports'
import { badRequest, field } from '../review/load'
import { statusFor, validateTaskFields } from './fields'
import { personTags } from './tags'
import { openTask, taskView } from './load'
import { announceReassign, canChangeAssignee } from './assignee'

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
  // #121: a Task someone has moves only by that person, the Owner or a PM.
  const moved = v.fields.assigneeLineUserId !== task.assigneeLineUserId
  if (moved && !(await canChangeAssignee(deps, task, requester))) {
    return { status: 403, body: { error: 'not_allowed' } }
  }
  // #109: a page that sends no tags keeps the Task's tags.
  const sent = field(body, 'tags')
  const tags = sent === undefined ? task.tags : personTags(sent)
  if (tags === null) return badRequest('tags')
  const status = statusFor(v.fields.assigneeLineUserId, task.status)
  const { updated } = await deps.store.updateTask(task.id, {
    ...v.fields, status, tags, lastEditedByLineUserId: requester, lastActivityAt: deps.now(),
  })
  // Deleted between the gate and the write: nothing was changed.
  if (!updated) return { status: 404, body: { error: 'not_found' } }
  log('task_edited', { taskId: task.id })
  // #29: the assignee may have left the group after validateTaskFields read them as live.
  const assignee = v.fields.assigneeLineUserId
  if (assignee !== null) {
    await releaseIfLeft(deps, { groupId: task.groupId, lineUserId: assignee, event: 'task_edit_assignee_left', taskId: task.id })
  }
  if (moved) await announceReassign(deps, { task, by: requester, from: task.assigneeLineUserId, to: assignee })
  const fresh = (await deps.store.getTask(task.id)) ?? task
  return { status: 200, body: await taskView(deps, fresh, requester) }
}
