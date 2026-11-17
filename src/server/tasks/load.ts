import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps, TaskRow, TaskStatus } from '../ports'
import { badRequest, field } from '../review/load'
import { canChangeAssignee } from './assignee'

export type TaskView = {
  taskId: string; title: string; details: string | null; status: TaskStatus
  assigneeLineUserId: string | null; dueAt: string | null                      // ISO
  tags: string[]                                                               // #109
  members: { lineUserId: string; displayName: string }[]                       // LINE names
  /** #121: the requester may change the assignee (always for an unowned Task). */
  canChangeAssignee: boolean
  /** #139: the Task is Done and the requester may reopen it (the same people as above). */
  canReopen: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FALLBACK_NAME = 'สมาชิก LINE'

/** Shared gate of the Task endpoints: verified LIFF user (401), UUID taskId (400),
 *  existing non-deleted Task (404), live Member of its group (403). The requester
 *  comes only from the verified ID token. */
export async function openTask(
  deps: Deps,
  body: unknown,
): Promise<{ ok: true; requester: string; task: TaskRow } | { ok: false; result: ApiResult }> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }
  const taskId = field(body, 'taskId')
  if (typeof taskId !== 'string' || !UUID.test(taskId)) return { ok: false, result: badRequest('taskId') }
  const task = await deps.store.getTask(taskId)
  if (!task || task.deletedAt) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  const allowed = await ensureGroupAccess(deps, {
    groupId: task.groupId, lineGroupId: task.lineGroupId, lineUserId: user.lineUserId,
  })
  if (!allowed) return { ok: false, result: { status: 403, body: { error: 'forbidden' } } }
  return { ok: true, requester: user.lineUserId, task }
}

export async function taskView(deps: Deps, task: TaskRow, requester: string): Promise<TaskView> {
  const [members, canChange] = await Promise.all([
    deps.store.listLiveMembers(task.groupId), canChangeAssignee(deps, task, requester),
  ])
  return {
    taskId: task.id, title: task.title, details: task.details, status: task.status,
    assigneeLineUserId: task.assigneeLineUserId, dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    tags: task.tags,
    members: members.map((m) => ({ lineUserId: m.lineUserId, displayName: m.displayName ?? FALLBACK_NAME })),
    canChangeAssignee: canChange,
    canReopen: task.status === 'done' && canChange,
  }
}

/** POST /api/tasks/load */
export async function loadTask(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openTask(deps, body)
  if (!gate.ok) return gate.result
  return { status: 200, body: await taskView(deps, gate.task, gate.requester) }
}
