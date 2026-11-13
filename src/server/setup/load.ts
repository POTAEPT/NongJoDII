import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps, GroupSetup, Member } from '../ports'
import { badRequest, field } from '../review/load'
import { isSetupOpen, setupState } from './rules'
import type { SetupLoad, SetupMember } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const FALLBACK_NAME = 'สมาชิก LINE'

/** Shared gate of the setup endpoints: verified LIFF user (401), UUID groupId (400),
 *  known group (404), live Member of it (403). The requester comes only from the ID token. */
export async function openSetupGroup(
  deps: Deps,
  body: unknown,
): Promise<{ ok: true; requester: string; group: GroupSetup } | { ok: false; result: ApiResult }> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }
  const groupId = field(body, 'groupId')
  if (typeof groupId !== 'string' || !UUID.test(groupId)) return { ok: false, result: badRequest('groupId') }
  const group = await deps.store.getGroupSetup(groupId)
  if (!group) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  const allowed = await ensureGroupAccess(deps, {
    groupId: group.groupId, lineGroupId: group.lineGroupId, lineUserId: user.lineUserId,
  })
  if (!allowed) return { ok: false, result: { status: 403, body: { error: 'forbidden' } } }
  return { ok: true, requester: user.lineUserId, group }
}

/** The LINE name of a person, or the fallback when LINE never gave one. */
export async function lineNameOf(deps: Deps, lineUserId: string, members?: Member[]): Promise<string> {
  const known = members?.find((m) => m.lineUserId === lineUserId)?.displayName
  if (known) return known
  return (await deps.store.findLineUser(lineUserId))?.displayName ?? FALLBACK_NAME
}

/** POST /api/setup/load: the setup form (#2b-#2d2) or the Owner confirm page. */
export async function loadSetup(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  // After the access check, which adds a requester LINE knows but we had not stored.
  const live = await deps.store.listLiveMembers(group.groupId)
  const state = setupState(group)
  const editable = isSetupOpen(state)
  // The setup form is where nicknames are edited, so they come back to it while it takes
  // changes (a resent form must not wipe them), and never once it is closed. Every other
  // screen shows LINE names only.
  const members: SetupMember[] = live
    .map((m) => ({
      lineUserId: m.lineUserId, displayName: m.displayName ?? FALLBACK_NAME,
      nicknames: editable ? m.nicknames : [], role: editable ? m.role : null,
    }))
    .sort((a, b) => (a.lineUserId === requester ? -1 : b.lineUserId === requester ? 1 : a.displayName.localeCompare(b.displayName, 'th')))
  const nomineeId = group.nominatedOwnerLineUserId
  const view: SetupLoad = {
    groupId: group.groupId,
    groupName: group.name,
    state,
    requesterLineUserId: requester,
    values: {
      workDescription: group.workDescription ?? '',
      features: {
        summarize: group.features.summarize, saveFiles: group.features.saveFiles,
        trackRemind: group.features.trackRemind, weeklySummary: group.features.weeklySummary,
      },
      dailyReminderTime: group.dailyReminderTime,
      weeklySummaryWeekday: group.weeklySummaryWeekday,
      weeklySummaryTime: group.weeklySummaryTime,
      ownerLineUserId: nomineeId,
    },
    members,
    nominee: nomineeId ? { lineUserId: nomineeId, displayName: await lineNameOf(deps, nomineeId, live) } : null,
  }
  return { status: 200, body: view }
}
