import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log } from '../log'
import type { ApiResult, Deps, SetupMemberWrite } from '../ports'
import { badRequest, field } from '../review/load'
import { setupDoneCard } from './card'
import { lineNameOf, openSetupGroup } from './load'
import {
  cleanNicknames, isIsoWeekday, isQuarterHour, isSetupOpen, MEMBERS_MAX, NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX,
  ROLE_MAX, setupState, WORK_DESCRIPTION_MAX,
} from './rules'
import type { SetupFeatures, SetupSubmitResult } from './types'

/** Share of the monthly LINE quota left unspent by the #2e card. The Owner cards are what
 *  the 10% reserve of the Tasks-created announce is kept for (review/notify.ts), so this
 *  matches the reminder post's 2%. Agent choice. */
export const SETUP_PUSH_RESERVE = 0.02

type Parsed = {
  workDescription: string | null; features: SetupFeatures; dailyReminderTime: string
  weeklySummaryWeekday: number; weeklySummaryTime: string; members: SetupMemberWrite[]; ownerLineUserId: string
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

/** Shape and size checks; the field name of the first bad value, or the clean values. */
function parse(body: unknown): { ok: true; value: Parsed } | { ok: false; field: string } {
  const wd = field(body, 'workDescription')
  if (typeof wd !== 'string' || wd.trim().length > WORK_DESCRIPTION_MAX) return { ok: false, field: 'workDescription' }

  const f = field(body, 'features')
  const features = f as Record<string, unknown> | null
  if (typeof f !== 'object' || features === null ||
      !isBool(features.summarize) || !isBool(features.saveFiles) ||
      !isBool(features.trackRemind) || !isBool(features.weeklySummary)) {
    return { ok: false, field: 'features' }
  }

  const daily = field(body, 'dailyReminderTime')
  if (!isQuarterHour(daily)) return { ok: false, field: 'dailyReminderTime' }
  const weekday = field(body, 'weeklySummaryWeekday')
  if (!isIsoWeekday(weekday)) return { ok: false, field: 'weeklySummaryWeekday' }
  const weekly = field(body, 'weeklySummaryTime')
  if (!isQuarterHour(weekly)) return { ok: false, field: 'weeklySummaryTime' }

  const rawMembers = field(body, 'members')
  if (!Array.isArray(rawMembers) || rawMembers.length > MEMBERS_MAX) return { ok: false, field: 'members' }
  const members: SetupMemberWrite[] = []
  for (const raw of rawMembers) {
    const m = raw as { lineUserId?: unknown; nicknames?: unknown; role?: unknown } | null
    if (!m || typeof m.lineUserId !== 'string' || m.lineUserId === '') return { ok: false, field: 'members' }
    if (members.some((x) => x.lineUserId === m.lineUserId)) return { ok: false, field: 'members' }
    if (!Array.isArray(m.nicknames) || !m.nicknames.every((n) => typeof n === 'string')) return { ok: false, field: 'members' }
    const nicknames = cleanNicknames(m.nicknames as string[])
    if (nicknames.length > NICKNAMES_PER_MEMBER_MAX || nicknames.some((n) => n.length > NICKNAME_MAX)) {
      return { ok: false, field: 'members' }
    }
    if (typeof m.role !== 'string' || m.role.trim().length > ROLE_MAX) return { ok: false, field: 'members' }
    const role = m.role.trim()
    members.push({ lineUserId: m.lineUserId, nicknames, role: role === '' ? null : role })
  }

  const owner = field(body, 'ownerLineUserId')
  if (typeof owner !== 'string' || owner === '') return { ok: false, field: 'ownerLineUserId' }

  return {
    ok: true,
    value: {
      workDescription: wd.trim() === '' ? null : wd.trim(),
      features: {
        summarize: features.summarize as boolean, saveFiles: features.saveFiles as boolean,
        trackRemind: features.trackRemind as boolean, weeklySummary: features.weeklySummary as boolean,
      },
      dailyReminderTime: daily, weeklySummaryWeekday: weekday, weeklySummaryTime: weekly,
      members, ownerLineUserId: owner,
    },
  }
}

const closed: ApiResult = { status: 409, body: { error: 'setup_closed' } }

/** POST /api/setup/submit. Saves the setup form and nominates the Owner; naming yourself
 *  confirms you at once and creates the Project (your LIFF login is the LINE login).
 *  Refused (409) once the group has a confirmed Owner or belongs to a Project: later
 *  edits belong to Settings (#28). Then pushes the #2e card to the group. */
export async function submitSetup(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  if (!isSetupOpen(setupState(group))) return closed

  const parsed = parse(body)
  if (!parsed.ok) return badRequest(parsed.field)
  const v = parsed.value
  // Only live Members of this group: the form edits them, it never adds anyone. A listed
  // person who left since the page loaded is dropped (setup_group writes live rows only
  // too), so the rest of the form still goes through. The Owner must still be here.
  const live = await deps.store.listLiveMembers(group.groupId)
  const liveIds = new Set(live.map((m) => m.lineUserId))
  if (!liveIds.has(v.ownerLineUserId)) return badRequest('ownerLineUserId')
  const members = v.members.filter((m) => liveIds.has(m.lineUserId))

  const at = deps.now()
  const { outcome } = await deps.store.saveGroupSetup({
    groupId: group.groupId, byLineUserId: requester, workDescription: v.workDescription,
    features: {
      summarize: v.features.summarize, draftTasks: v.features.summarize, saveFiles: v.features.saveFiles,
      trackRemind: v.features.trackRemind, weeklySummary: v.features.weeklySummary,
    },
    dailyReminderTime: v.dailyReminderTime, weeklySummaryWeekday: v.weeklySummaryWeekday,
    weeklySummaryTime: v.weeklySummaryTime, members, ownerLineUserId: v.ownerLineUserId, at,
  })
  // Rechecked under the row lock: another form or a confirm got in first, or the Owner left.
  if (outcome === 'closed') return closed
  if (outcome === 'owner_not_member') return badRequest('ownerLineUserId')
  const confirmed = outcome === 'confirmed'
  log('setup_saved', { groupId: group.groupId, ownerConfirmed: confirmed })
  // The nomination time the row now holds: setup_group keeps it while the nominee stays,
  // and a new nominee (a self-confirm included) gets this send's time.
  const nominatedAt = (group.nominatedOwnerLineUserId === v.ownerLineUserId ? group.ownerNominatedAt : null) ?? at

  // Every send pushes the #2e card, under a LINE retry key made from the nominee, the
  // outcome and the nomination time. A resend therefore repeats the earlier card's key:
  // LINE drops the repeat when that card was delivered (409, counted as success) and
  // delivers it when it failed or was skipped for quota, so the Owner confirm link always
  // reaches the group. A new nominee, even one named before, has a new time, a new key
  // and a new card.
  const pendingOwnerName = confirmed ? null : await lineNameOf(deps, v.ownerLineUserId, live)
  const posted = await pushToGroupWithinBudget(deps, {
    purpose: 'setup_done',
    groupId: group.groupId,
    lineGroupId: group.lineGroupId,
    messages: [setupDoneCard({ liffId: deps.config.liffId, groupId: group.groupId, pendingOwnerName })],
    reserve: SETUP_PUSH_RESERVE,
    retryKey: retryKeyFrom(`setup_done:${group.groupId}:${v.ownerLineUserId}:${outcome}:${nominatedAt.toISOString()}`),
  })
  const result: SetupSubmitResult = { state: confirmed ? 'confirmed' : 'pending_owner', posted }
  return { status: 200, body: result }
}
