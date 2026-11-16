import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log, logError } from '../log'
import type { Deps, TaskRow } from '../ports'

// #121 Who may move a Task someone already has, and the group notice when it moves.
//
// - An unowned Task: any live Member may assign it (unchanged).
// - A Task with an assignee: only that assignee, the group's confirmed Owner or a PM of the
//   Project (the Project's owner, or group_members.is_pm) may change or clear it. Title,
//   details, due date and tags keep today's rule (any live Member).
// - When someone other than the new assignee moves it, one short text goes to the group
//   through the push budget (purpose task_reassigned), skipped near the monthly quota.
//   Taking a Task yourself sends nothing.

export const ASSIGNEE_TEXT = {
  notAllowed: 'เปลี่ยนผู้รับได้เฉพาะผู้รับงาน เจ้าของบอท หรือ PM',
  nobody: 'ยังไม่มีผู้รับ',
  moved: (by: string, title: string, from: string, to: string) => `${by} เปลี่ยนผู้รับงาน "${title}" จาก ${from} เป็น ${to}`,
} as const

/** Share of the monthly quota the notice leaves unspent: as the other group cards. */
export const REASSIGN_PUSH_RESERVE = 0.1
const TITLE_MAX = 60
const FALLBACK_NAME = 'สมาชิก LINE'

/** May the requester change this Task's assignee? Always for an unowned Task. */
export async function canChangeAssignee(deps: Deps, task: TaskRow, requester: string): Promise<boolean> {
  if (task.assigneeLineUserId === null || task.assigneeLineUserId === requester) return true
  const group = await deps.store.getGroupById(task.groupId)
  if (group && group.ownerConfirmedAt !== null && group.nominatedOwnerLineUserId === requester) return true
  const memberships = await deps.store.listDashboardMemberships(requester)
  return memberships.some((m) => m.groupId === task.groupId && !m.left && (m.isPm || m.projectOwnerLineUserId === requester))
}

/** The group notice after a move. Never throws. */
export async function announceReassign(
  deps: Deps,
  p: { task: TaskRow; by: string; from: string | null; to: string | null },
): Promise<void> {
  if (p.from === p.to || p.to === p.by) return // no move, or the person took it themselves
  try {
    const members = await deps.store.listLiveMembers(p.task.groupId)
    const nameOf = async (id: string | null): Promise<string> => {
      if (id === null) return ASSIGNEE_TEXT.nobody
      const live = members.find((m) => m.lineUserId === id)?.displayName
      if (live) return live
      return (await deps.store.findLineUser(id))?.displayName ?? FALLBACK_NAME
    }
    const title = p.task.title.length > TITLE_MAX ? `${p.task.title.slice(0, TITLE_MAX - 1)}…` : p.task.title
    const text = ASSIGNEE_TEXT.moved(await nameOf(p.by), title, await nameOf(p.from), await nameOf(p.to))
    const result = await pushToGroupWithinBudget(deps, {
      purpose: 'task_reassigned', groupId: p.task.groupId, lineGroupId: p.task.lineGroupId,
      messages: [{ type: 'text', text }], reserve: REASSIGN_PUSH_RESERVE,
      retryKey: retryKeyFrom(`task_reassigned:${p.task.id}:${p.from ?? '-'}:${p.to ?? '-'}:${deps.now().toISOString()}`),
    })
    log('task_reassigned', { taskId: p.task.id, result })
  } catch (err) {
    logError('task_reassigned_failed', { taskId: p.task.id }, err)
  }
}
