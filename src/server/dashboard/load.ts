import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, DashboardGroupRow, DashboardMembership, Deps, TaskStatus } from '../ports'
import { badRequest, field } from '../review/load'

// #17 (9a) Dashboard data and access. The screen is #18 (app/liff/dashboard-view.tsx).
//
// Project membership rule (docs/PROJECT.md, decided 2026-11-11). A person is a member of a
// group of a Project when they are named in its setup form, or sent a message in it, or
// opened the LIFF from it, or joined it after the bot. Those paths all write a
// group_members row; a person who leaves keeps the row with left_at set and loses access.
//
// What the requester sees:
//   - Member: only the groups where they are a live member, with those groups' Tasks.
//   - PM: every group of the Project (the Project's Owner, or a member marked group_members.is_pm,
//     while they are a live member of at least one of its groups), except a group they left.
//   - Outsider (no live membership in any group of a Project): refused with 403.
// The requester comes only from the verified LIFF ID token. Names are LINE names, never nicknames.

export type DashboardTask = {
  taskId: string; title: string; status: TaskStatus
  assigneeLineUserId: string | null
  assigneeName: string | null // LINE name; kept for a Member who left, so Done Tasks keep it
  dueAt: string | null // ISO
}
export type DashboardMember = { lineUserId: string; displayName: string | null }
export type DashboardGroup = { groupId: string; name: string | null; members: DashboardMember[]; tasks: DashboardTask[] }
export type DashboardData = { role: 'pm' | 'member'; groups: DashboardGroup[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The access rule, pure. `groups` are the groups of every Project the requester has a live
 *  membership in. Returns the groups to show and whether the requester is a PM of any of them;
 *  an empty list means the requester is an outsider. */
export function visibleGroups(
  requester: string,
  memberships: DashboardMembership[],
  groups: DashboardGroupRow[],
): { groups: DashboardGroupRow[]; pm: boolean } {
  const live = memberships.filter((m) => !m.left)
  const liveGroups = new Set(live.map((m) => m.groupId))
  const leftGroups = new Set(memberships.filter((m) => m.left).map((m) => m.groupId))
  const pmProjects = new Set(
    live.filter((m) => m.isPm || m.projectOwnerLineUserId === requester).map((m) => m.projectId),
  )
  const shown = groups.filter((g) =>
    pmProjects.has(g.projectId) ? !leftGroups.has(g.groupId) : liveGroups.has(g.groupId),
  )
  return { groups: shown, pm: shown.some((g) => pmProjects.has(g.projectId)) }
}

/** POST /api/dashboard/load. Body: { idToken, groupId? }. groupId (groups.id, from the weekly
 *  insight's button) counts as "opens the LIFF from a group" when LINE says the person is in it. */
export async function loadDashboard(deps: Deps, body: unknown): Promise<ApiResult> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { status: 401, body: { error: 'unauthorized' } }

  const linked = field(body, 'groupId')
  if (linked !== undefined && linked !== null) {
    if (typeof linked !== 'string' || !UUID.test(linked)) return badRequest('groupId')
    const group = await deps.store.getGroupById(linked)
    // Only a group of a Project counts. A person who left it, or LINE does not list, gains nothing.
    if (group?.projectId) {
      await ensureGroupAccess(deps, { groupId: group.id, lineGroupId: group.lineGroupId, lineUserId: user.lineUserId })
    }
  }

  const memberships = await deps.store.listDashboardMemberships(user.lineUserId)
  const projectIds = [...new Set(memberships.filter((m) => !m.left).map((m) => m.projectId))]
  const { groups, pm } = visibleGroups(user.lineUserId, memberships, await deps.store.listProjectGroups(projectIds))
  if (groups.length === 0) return { status: 403, body: { error: 'forbidden' } }

  const groupIds = groups.map((g) => g.groupId)
  const [members, tasks] = await Promise.all([deps.store.listDashboardMembers(groupIds), deps.store.listDashboardTasks(groupIds)])
  const data: DashboardData = {
    role: pm ? 'pm' : 'member',
    groups: groups.map((g) => ({
      groupId: g.groupId,
      name: g.name,
      members: members.filter((m) => m.groupId === g.groupId).map((m) => ({ lineUserId: m.lineUserId, displayName: m.displayName })),
      tasks: tasks.filter((t) => t.groupId === g.groupId).map((t) => ({
        taskId: t.id, title: t.title, status: t.status, assigneeLineUserId: t.assigneeLineUserId,
        assigneeName: t.assigneeName, dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      })),
    })),
  }
  return { status: 200, body: data }
}
