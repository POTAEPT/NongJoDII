import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps, TaskRow, TaskStatus } from '../ports'
import { badRequest, field } from '../review/load'

export type TaskView = {
  taskId: string; title: string; details: string | null; status: TaskStatus
  assigneeLineUserId: string | null; dueAt: string | null                      // ISO
  members: { lineUserId: string; displayName: string }[]                       // LINE names
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

export async function taskView(deps: Deps, task: TaskRow): Promise<TaskView> {
  const members = await deps.store.listLiveMembers(task.groupId)
  return {
    taskId: task.id, title: task.title, details: task.details, status: task.status,
    assigneeLineUserId: task.assigneeLineUserId, dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    members: members.map((m) => ({ lineUserId: m.lineUserId, displayName: m.displayName ?? FALLBACK_NAME })),
  }
}

/** POST /api/tasks/load */
export async function loadTask(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openTask(deps, body)
  if (!gate.ok) return gate.result
  return { status: 200, body: await taskView(deps, gate.task) }
}
