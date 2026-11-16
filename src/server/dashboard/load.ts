import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, DashboardGroupRow, DashboardMembership, Deps, LatestWeeklyInsight, TaskStatus } from '../ports'
import { badRequest, field } from '../review/load'

// #17 (9a) Dashboard data and access. The screen is #18 (app/liff/dashboard-view.tsx).
//
// Project membership rule (docs/PROJECT.md, decided 2026-11-11). A person is a member of a
// group of a Project when they are named in its setup form, or sent a message in it, or
// opened the LIFF from it, or joined it after the bot. Those paths all write a
// group_members row; a person who leaves keeps the row with left_at set and loses access.
//
// What the requester sees (#90, decided 2026-11-15: one Dashboard, split by role):
//   - PM (the Project's Owner, or a member marked group_members.is_pm, while they are a live
//     member of at least one of its groups): every group of that Project, except a group they
//     left, as an overview: every Task (unowned ones too, so the Owner can assign them), every
//     Member, the weekly insight and the saved files. access = 'overview'.
//   - Member: only the groups where they are a live member, as "งานของฉัน": the Tasks
//     assigned to them plus the group's unowned Tasks (anyone may take one; decided
//     2026-11-16), the Member list with LINE names, the saved files and the weekly insight
//     (team counts only, the same card the whole group gets). Never a Task assigned to
//     someone else. access = 'mine'.
//     The filter is applied here, so a Member's payload never holds other people's Tasks.
//   - Someone can be a PM of one Project and a Member in another: access is per group.
//   - Outsider (no live membership in any group of a Project): refused with 403.
// Every group says who its confirmed Owner is (ownerLineUserId), for the เจ้าของบอท badge.
// The requester comes only from the verified LIFF ID token. Names are LINE names, never nicknames.

export type DashboardTask = {
  taskId: string; title: string; status: TaskStatus
  assigneeLineUserId: string | null
  assigneeName: string | null // LINE name; kept for a Member who left, so Done Tasks keep it
  dueAt: string | null // ISO
  tags: string[] // #109
}
export type DashboardMember = { lineUserId: string; displayName: string | null }
/** #22: the group's latest weekly insight (counts saved on its weekly day). posted false: it
 *  never reached the group (skipped near the LINE quota, failed, or no Tasks), so the
 *  Dashboard is where it shows. */
export type DashboardInsight = { weekStart: string; done: number; inProcess: number; awaitingOwner: number; posted: boolean }
/** #4: a file the bot saved to Drive from this group (newest first). The link opens without
 *  a Google account when the Project folder is shared "anyone with the link"; if a Google
 *  Workspace policy refused that share, only the Drive's owner can open it (not marked here).
 *  A saved card skipped near the LINE quota leaves the file here only. */
export type DashboardFile = {
  fileId: string; fileName: string; driveLink: string; sizeBytes: number | null; savedAt: string; senderName: string | null
}
/** 'overview': the requester is a PM of this group's Project and sees everything.
 *  'mine': a Member; tasks holds only their own Tasks and the unowned ones. */
export type DashboardAccess = 'overview' | 'mine'
export type DashboardGroup = {
  groupId: string; name: string | null; access: DashboardAccess
  /** The group's confirmed Owner (the เจ้าของบอท badge); null while none is confirmed. */
  ownerLineUserId: string | null
  members: DashboardMember[]; tasks: DashboardTask[]; insight: DashboardInsight | null
  files: DashboardFile[]
}
/** role 'pm': at least one group is an overview (the page may offer the comparison of those). */
export type DashboardData = { role: 'pm' | 'member'; groups: DashboardGroup[] }

function insightOf(i: LatestWeeklyInsight | undefined): DashboardInsight | null {
  if (!i) return null
  return { weekStart: i.weekStart, ...i.counts, posted: i.postedAt !== null }
}

/** Files per group on the Dashboard. */
export const DASHBOARD_FILES_LIMIT = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The access rule, pure. `groups` are the groups of every Project the requester has a live
 *  membership in. Returns the groups to show, whether the requester is a PM of any of them,
 *  and which shown groups they see as an overview (a PM of that group's Project); an empty
 *  list means the requester is an outsider. */
export function visibleGroups(
  requester: string,
  memberships: DashboardMembership[],
  groups: DashboardGroupRow[],
): { groups: DashboardGroupRow[]; pm: boolean; overview: Set<string> } {
  const live = memberships.filter((m) => !m.left)
  const liveGroups = new Set(live.map((m) => m.groupId))
  const leftGroups = new Set(memberships.filter((m) => m.left).map((m) => m.groupId))
  const pmProjects = new Set(
    live.filter((m) => m.isPm || m.projectOwnerLineUserId === requester).map((m) => m.projectId),
  )
  const shown = groups.filter((g) =>
    pmProjects.has(g.projectId) ? !leftGroups.has(g.groupId) : liveGroups.has(g.groupId),
  )
  const overview = new Set(shown.filter((g) => pmProjects.has(g.projectId)).map((g) => g.groupId))
  return { groups: shown, pm: overview.size > 0, overview }
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
  const { groups, pm, overview } = visibleGroups(user.lineUserId, memberships, await deps.store.listProjectGroups(projectIds))
  if (groups.length === 0) return { status: 403, body: { error: 'forbidden' } }

  const groupIds = groups.map((g) => g.groupId)
  const [members, tasks, insights, files] = await Promise.all([
    deps.store.listDashboardMembers(groupIds), deps.store.listDashboardTasks(groupIds), deps.store.listLatestWeeklyInsights(groupIds),
    deps.store.listDashboardFiles(groupIds, DASHBOARD_FILES_LIMIT),
  ])
  const data: DashboardData = {
    role: pm ? 'pm' : 'member',
    groups: groups.map((g) => {
      const access: DashboardAccess = overview.has(g.groupId) ? 'overview' : 'mine'
      return {
        groupId: g.groupId,
        name: g.name,
        access,
        ownerLineUserId: g.ownerLineUserId,
        members: members.filter((m) => m.groupId === g.groupId).map((m) => ({ lineUserId: m.lineUserId, displayName: m.displayName })),
        // A Member gets only their own Tasks and the unowned ones: filtered here, never only
        // in the page, so another person's Task never reaches them.
        tasks: tasks
          .filter((t) => t.groupId === g.groupId &&
            (access === 'overview' || t.assigneeLineUserId === user.lineUserId || t.assigneeLineUserId === null))
          .map((t) => ({
            taskId: t.id, title: t.title, status: t.status, assigneeLineUserId: t.assigneeLineUserId,
            assigneeName: t.assigneeName, dueAt: t.dueAt ? t.dueAt.toISOString() : null, tags: t.tags,
          })),
        insight: insightOf(insights.find((i) => i.groupId === g.groupId)),
        files: files.filter((f) => f.groupId === g.groupId).map((f) => ({
          fileId: f.id, fileName: f.fileName, driveLink: f.driveLink, sizeBytes: f.sizeBytes,
          savedAt: f.savedAt.toISOString(), senderName: f.senderName,
        })),
      }
    }),
  }
  return { status: 200, body: data }
}
