import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { canChangeAssignee } from './assignee'
import { openTask, taskView } from './load'

// #139: "ยังไม่เสร็จ" on the Task page. A Task closed by mistake (a wrong pick on the progress
// picker, the #87 card points here) goes back to In Process with its assignee, or to Not
// Assigned when it has none. A person's action (rules: Tasks and AI), by the same people who
// may move the assignee (#121): the assignee, the Owner or a PM. No group message: the person
// who closed it by mistake fixes it quietly, as with an edit.

/** POST /api/tasks/reopen { idToken, taskId } */
export async function reopenTaskFromLiff(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openTask(deps, body)
  if (!gate.ok) return gate.result
  const { task, requester } = gate
  if (task.status !== 'done') return { status: 409, body: { error: 'not_done' } }
  if (!(await canChangeAssignee(deps, task, requester))) return { status: 403, body: { error: 'not_allowed' } }
  const { updated } = await deps.store.reopenTask({
    taskId: task.id, assignee: task.assigneeLineUserId,
    toStatus: task.assigneeLineUserId === null ? 'not_assigned' : 'in_process',
    by: requester, at: deps.now(),
  })
  const fresh = await deps.store.getTask(task.id)
  if (!fresh || fresh.deletedAt) return { status: 404, body: { error: 'not_found' } }
  // Changed since the read (reopened, reassigned): answer what it is now, as a conflict.
  if (!updated) return { status: 409, body: { error: 'changed', task: await taskView(deps, fresh, requester) } }
  log('task_reopened', { taskId: task.id })
  return { status: 200, body: await taskView(deps, fresh, requester) }
}
