import { log, logError } from '../log'
import type { ApiResult, Deps, GroupSetup } from '../ports'
import { botLeaveGroup } from '../removal/leave'
import { badRequest } from '../review/load'
import { FALLBACK_NAME, lineNameOf, openSetupGroup } from '../setup/load'
import { setupState } from '../setup/rules'
import { parseGroupValues } from '../setup/submit'
import type { SettingsLoad, SettingsMember } from './types'

// #28 Settings: everything the setup form set, edited later by the group's confirmed Owner.
// Every live Member may look; only the Owner may change, except that each Member edits their
// own nicknames and role through /api/me/save (#81, members/profile.ts). The Owner is the person the group
// names (groups.nominated_owner_line_user_id) once they confirmed (owner_confirmed_at); every
// group of a Project names the same person, so this covers Sub groups too. Changing the
// Owner belongs to the Owner change flow (#30, #31). Stop using (#11) is stopUsing below.

function isConfirmedOwner(group: GroupSetup, lineUserId: string): boolean {
  return group.ownerConfirmedAt !== null && group.nominatedOwnerLineUserId === lineUserId
}

/** POST /api/settings/load */
export async function loadSettings(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  const canEdit = isConfirmedOwner(group, requester)
  const live = await deps.store.listLiveMembers(group.groupId)
  // #81: every live Member sees everyone's nicknames and role here; the Owner edits every
  // row, a Member only their own. Nicknames still never show outside Settings and the form.
  const members: SettingsMember[] = live
    .map((m) => ({
      lineUserId: m.lineUserId, displayName: m.displayName ?? FALLBACK_NAME, nicknames: m.nicknames, role: m.role,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'th'))
  const ownerId = group.ownerConfirmedAt !== null ? group.nominatedOwnerLineUserId : null
  // #80: a nominee who has not confirmed yet, only before the group has a Project (the only
  // time the setup form's Owner confirm applies). In two other states the nominee column
  // still names a previous Owner, so nobody is "pending": after an Owner left (#30), and a
  // Sub group waiting on the take-over question (#31: a Project, no confirmed Owner).
  const pendingId = setupState(group) === 'pending_owner' && group.ownerLeftAt === null
    ? group.nominatedOwnerLineUserId : null
  const view: SettingsLoad = {
    groupId: group.groupId,
    groupName: group.name,
    state: setupState(group) === 'confirmed' ? 'ready' : 'not_set_up',
    canEdit,
    requesterLineUserId: requester,
    owner: ownerId ? { lineUserId: ownerId, displayName: await lineNameOf(deps, ownerId, live) } : null,
    pendingOwner: pendingId
      ? { lineUserId: pendingId, displayName: await lineNameOf(deps, pendingId, live), isRequester: pendingId === requester }
      : null,
    values: {
      workDescription: group.workDescription ?? '',
      features: {
        summarize: group.features.summarize, saveFiles: group.features.saveFiles,
        trackRemind: group.features.trackRemind, weeklySummary: group.features.weeklySummary,
      },
      dailyReminderTime: group.dailyReminderTime,
      weeklySummaryWeekday: group.weeklySummaryWeekday,
      tagSet: group.tagSet,
      weeklySummaryTime: group.weeklySummaryTime,
    },
    members,
  }
  return { status: 200, body: view }
}

const notOwner: ApiResult = { status: 403, body: { error: 'not_owner' } }

/** POST /api/settings/submit: the setup form's body without ownerLineUserId. A time change
 *  takes effect on the next 15-minute tick (a day already reminded is not reminded again). */
export async function submitSettings(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  if (!isConfirmedOwner(group, requester)) return notOwner
  const parsed = parseGroupValues(body)
  if (!parsed.ok) return badRequest(parsed.field)
  const v = parsed.value
  // Only live Members whose nicknames or role changed: Settings edits them, it never adds
  // anyone. One who left since the page loaded is dropped so the rest still saves, and an
  // unchanged one costs no write (the page sends every Member on each save).
  const live = new Map((await deps.store.listLiveMembers(group.groupId)).map((m) => [m.lineUserId, m]))
  const changed = v.members.filter((m) => {
    const now = live.get(m.lineUserId)
    return now !== undefined && (now.role !== m.role || JSON.stringify(now.nicknames) !== JSON.stringify(m.nicknames))
  })
  const { saved } = await deps.store.saveGroupSettings({
    groupId: group.groupId, ownerLineUserId: requester, workDescription: v.workDescription,
    features: {
      summarize: v.features.summarize, draftTasks: v.features.summarize, saveFiles: v.features.saveFiles,
      trackRemind: v.features.trackRemind, weeklySummary: v.features.weeklySummary,
    },
    dailyReminderTime: v.dailyReminderTime, weeklySummaryWeekday: v.weeklySummaryWeekday,
    weeklySummaryTime: v.weeklySummaryTime,
    members: changed,
    tagSet: v.tagSet,
  })
  // The Owner changed between the check above and the write.
  if (!saved) return notOwner
  log('settings_saved', { groupId: group.groupId })
  return { status: 200, body: { saved: true } }
}

/** POST /api/settings/stop-using { idToken, groupId, confirm: true }: Stop using (#11). The
 *  confirmed Owner makes the bot leave the group; the group's data is deleted 7 days later
 *  unless the bot is invited back first, and files stay in the Owner's Drive. `confirm`
 *  is the page's confirm step: without it nothing happens. LINE refusing or failing the
 *  leave answers 502 and marks nothing, so the Owner can try again. */
export async function stopUsing(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  if (!isConfirmedOwner(group, requester)) return notOwner
  if ((body as { confirm?: unknown }).confirm !== true) return badRequest('confirm')
  let deleteAfter: Date | null
  try {
    ({ deleteAfter } = await botLeaveGroup(deps, { groupId: group.groupId, reason: 'stop_using', now: deps.now() }))
  } catch (err) {
    logError('stop_using_failed', { groupId: group.groupId }, err)
    return { status: 502, body: { error: 'line_failed' } }
  }
  return { status: 200, body: { left: true, deleteAfter: deleteAfter?.toISOString() ?? null } }
}
