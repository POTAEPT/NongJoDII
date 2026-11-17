import { personTags, TAG_SET_MAX } from '../tasks/tags'
import { driveDeadline, ensureGroupFolder, syncDriveForOwner } from '../google/drive-folders'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log, logError } from '../log'
import type { ApiResult, Defer, Deps, GroupSetup, Member, SetupMemberWrite, SetupOutcome } from '../ports'
import { badRequest, field } from '../review/load'
import { setupDoneCard } from './card'
import { lineNameOf, openSetupGroup } from './load'
import { takeOverOwner } from './owner-change'
import {
  cleanNicknames, isIsoWeekday, isQuarterHour, isSetupOpen, MEMBERS_MAX, NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX,
  ROLE_MAX, setupState, WORK_DESCRIPTION_MAX,
} from './rules'
import type { SetupFeatures, SetupResendResult, SetupSubmitResult } from './types'

/** Share of the monthly LINE quota left unspent by the #2e card. The Owner cards are what
 *  the 10% reserve of the Tasks-created announce is kept for (review/notify.ts), so this
 *  matches the reminder post's 2%. Agent choice. */
export const SETUP_PUSH_RESERVE = 0.02

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The setup form's values without the Owner: what Settings (#28) edits too. */
export type GroupValues = {
  workDescription: string | null; features: SetupFeatures; dailyReminderTime: string
  weeklySummaryWeekday: number; weeklySummaryTime: string; members: SetupMemberWrite[]
  /** #110: the group's starting tags, optional (missing = none). */
  tagSet: string[]
}
type Parsed = GroupValues & { ownerLineUserId: string; attachProjectId: string | null }

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

/** Shape and size checks of the values the setup form and Settings share; the field name of
 *  the first bad value, or the clean values. */
export function parseGroupValues(body: unknown): { ok: true; value: GroupValues } | { ok: false; field: string } {
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

  // #110: the starting tags; the field may be missing (an older page, or skipped).
  const tagSet = personTags(field(body, 'tagSet'), TAG_SET_MAX)
  if (tagSet === null) return { ok: false, field: 'tagSet' }

  return {
    ok: true,
    value: {
      tagSet,
      workDescription: wd.trim() === '' ? null : wd.trim(),
      features: {
        summarize: features.summarize as boolean, saveFiles: features.saveFiles as boolean,
        trackRemind: features.trackRemind as boolean, weeklySummary: features.weeklySummary as boolean,
      },
      dailyReminderTime: daily, weeklySummaryWeekday: weekday, weeklySummaryTime: weekly,
      members,
    },
  }
}

/** The setup form: the shared values plus the Owner it names. */
function parse(body: unknown): { ok: true; value: Parsed } | { ok: false; field: string } {
  const values = parseGroupValues(body)
  if (!values.ok) return values
  const owner = field(body, 'ownerLineUserId')
  if (typeof owner !== 'string' || owner === '') return { ok: false, field: 'ownerLineUserId' }
  // #146: optional; missing or null = a new Project.
  const attach = field(body, 'attachProjectId')
  if (attach !== undefined && attach !== null && (typeof attach !== 'string' || !UUID.test(attach))) return { ok: false, field: 'attachProjectId' }
  return { ok: true, value: { ...values.value, ownerLineUserId: owner, attachProjectId: (attach as string | null | undefined) ?? null } }
}

const closed: ApiResult = { status: 409, body: { error: 'setup_closed' } }

/** POST /api/setup/submit. Saves the setup form and nominates the Owner; naming yourself
 *  confirms you at once and creates the Project (your LIFF login is the LINE login).
 *  Refused (409) once the group has a confirmed Owner or belongs to a Project: later
 *  edits belong to Settings (#28). Then pushes the #2e card to the group. A self-confirmed
 *  Owner already signed in to Google gets the Drive folders (#13) after the response. */
export async function submitSetup(deps: Deps, body: unknown, defer: Defer): Promise<ApiResult> {
  // The route's 60 s cover this handler, its LINE calls and its after() work: the Drive
  // work is timed from here.
  const deadline = driveDeadline(deps.now())
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  if (!isSetupOpen(setupState(group))) return closed

  const parsed = parse(body)
  if (!parsed.ok) return badRequest(parsed.field)
  const v = parsed.value
  // A group whose Owner left and that has no Project (a Sub group detached by #30 part B):
  // setup_group would confirm a sender who names themselves at once, without Drive. The
  // role goes through the owner_needed flow instead (setup/owner-change.ts): naming yourself
  // is the claim (your LIFF login is the LINE login), and it takes effect only with a valid
  // Google sign-in, here or on the Google callback. The form's other values are not saved
  // then: the group keeps its earlier settings, and the new Owner edits them in Settings.
  // Naming someone else is refused: that person presses the card themselves.
  if (group.ownerLeftAt !== null) {
    if (v.ownerLineUserId !== requester) return { status: 409, body: { error: 'owner_needed' } }
    return takeOverOwner(deps, group, requester, defer, deadline)
  }
  // Only live Members of this group: the form edits them, it never adds anyone. A listed
  // person who left since the page loaded is dropped (setup_group writes live rows only
  // too), so the rest of the form still goes through. The Owner must still be here.
  const live = await deps.store.listLiveMembers(group.groupId)
  const liveIds = new Set(live.map((m) => m.lineUserId))
  if (!liveIds.has(v.ownerLineUserId)) return badRequest('ownerLineUserId')
  const members = v.members.filter((m) => liveIds.has(m.lineUserId))

  const at = deps.now()
  if (v.attachProjectId !== null) {
    return attachSubGroup(deps, defer, deadline, { group, requester, v, members, at })
  }
  const { outcome } = await deps.store.saveGroupSetup({
    groupId: group.groupId, byLineUserId: requester, workDescription: v.workDescription,
    features: {
      summarize: v.features.summarize, draftTasks: v.features.summarize, saveFiles: v.features.saveFiles,
      trackRemind: v.features.trackRemind, weeklySummary: v.features.weeklySummary,
    },
    dailyReminderTime: v.dailyReminderTime, weeklySummaryWeekday: v.weeklySummaryWeekday,
    weeklySummaryTime: v.weeklySummaryTime, members, ownerLineUserId: v.ownerLineUserId, at, tagSet: v.tagSet,
  })
  // Rechecked under the row lock: another form or a confirm got in first, or the Owner left.
  if (outcome === 'closed') return closed
  if (outcome === 'owner_not_member') return badRequest('ownerLineUserId')
  const confirmed = outcome === 'confirmed'
  log('setup_saved', { groupId: group.groupId, ownerConfirmed: confirmed })
  if (confirmed) defer(() => syncDriveForOwner(deps, requester, deadline))
  const nominatedAt = await storedNominationTime(deps, group.groupId, v.ownerLineUserId, at)

  // Every send pushes the #2e card, under a LINE retry key made from the nominee, the
  // outcome and the nomination time. A resend therefore repeats the earlier card's key:
  // LINE drops the repeat when that card was delivered (409, counted as success) and
  // delivers it when it failed or was skipped for quota, so the Owner confirm link always
  // reaches the group. A new nominee, even one named before, has a new time, a new key
  // and a new card.
  const pendingOwnerName = confirmed ? null : await lineNameOf(deps, v.ownerLineUserId, live)
  const posted = await pushSetupCard(deps, group, { owner: v.ownerLineUserId, outcome, nominatedAt, pendingOwnerName })
  const result: SetupSubmitResult = { state: confirmed ? 'confirmed' : 'pending_owner', posted }
  return { status: 200, body: result }
}

/** #146: the form saved and the group attached as a Sub group of a Project the sender owns,
 *  in one transaction (rpc setup_sub_group). The sender is the Project's owner, so they are
 *  confirmed at once and need no new Google sign-in: the Sub group's folder is made in the
 *  Project's Drive after the response. */
async function attachSubGroup(
  deps: Deps, defer: Defer, deadline: Date,
  p: { group: GroupSetup; requester: string; v: Parsed; members: SetupMemberWrite[]; at: Date },
): Promise<ApiResult> {
  const { group, requester, v, members, at } = p
  // The Sub group's Owner is the Project's owner: the form cannot name anyone else.
  if (v.ownerLineUserId !== requester) return badRequest('ownerLineUserId')
  const { outcome } = await deps.store.saveSubGroupSetup({
    groupId: group.groupId, projectId: v.attachProjectId as string, byLineUserId: requester, workDescription: v.workDescription,
    features: {
      summarize: v.features.summarize, draftTasks: v.features.summarize, saveFiles: v.features.saveFiles,
      trackRemind: v.features.trackRemind, weeklySummary: v.features.weeklySummary,
    },
    dailyReminderTime: v.dailyReminderTime, weeklySummaryWeekday: v.weeklySummaryWeekday,
    weeklySummaryTime: v.weeklySummaryTime, members, at, tagSet: v.tagSet,
  })
  if (outcome === 'closed') return closed
  if (outcome === 'not_member') return badRequest('ownerLineUserId')
  if (outcome === 'not_project_owner') return { status: 403, body: { error: 'not_project_owner' } }
  log('setup_saved', { groupId: group.groupId, ownerConfirmed: true, attached: true })
  defer(async () => {
    try {
      await ensureGroupFolder(deps, group.groupId, deadline)
    } catch (err) {
      // The first file save makes the folder too (openGroupDrive), so this is only early.
      logError('sub_group_folder_failed', { groupId: group.groupId }, err)
    }
  })
  const posted = await pushSetupCard(deps, group, { owner: requester, outcome: 'confirmed', nominatedAt: at, pendingOwnerName: null })
  const result: SetupSubmitResult = { state: 'confirmed', posted, attached: true }
  return { status: 200, body: result }
}

/** The #2e card, under the key of its nomination (see submitSetup). */
async function pushSetupCard(
  deps: Deps,
  group: Pick<GroupSetup, 'groupId' | 'lineGroupId'>,
  c: { owner: string; outcome: SetupOutcome; nominatedAt: Date; pendingOwnerName: string | null },
) {
  // #143: the card repeats what was saved; a failed read only drops the recap.
  const recap = await deps.store.getGroupSetup(group.groupId).catch((err) => {
    logError('setup_recap_read_failed', { groupId: group.groupId }, err)
    return null
  })
  return pushToGroupWithinBudget(deps, {
    purpose: 'setup_done',
    groupId: group.groupId,
    lineGroupId: group.lineGroupId,
    messages: [setupDoneCard({ liffId: deps.config.liffId, groupId: group.groupId, pendingOwnerName: c.pendingOwnerName, recap })],
    reserve: SETUP_PUSH_RESERVE,
    retryKey: retryKeyFrom(`setup_done:${group.groupId}:${c.owner}:${c.outcome}:${c.nominatedAt.toISOString()}`),
  })
}

/** POST /api/setup/resend-card: pushes the #2e card again for the nomination the group
 *  holds now. Saves nothing: the form on the page may be stale, and sending it again would
 *  undo another Member's later changes. The key is the saved nomination's own key, so LINE
 *  drops the repeat of a card it already delivered. 409 unless an Owner is pending. */
export async function resendSetupCard(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group } = gate
  const owner = group.nominatedOwnerLineUserId
  if (setupState(group) !== 'pending_owner' || owner === null) return closed

  const live: Member[] = await deps.store.listLiveMembers(group.groupId)
  const ownerName = await lineNameOf(deps, owner, live)
  // A row without a nomination time (written before the column) gets a fresh key: it can
  // only repeat a card, never lose one.
  const nominatedAt = group.ownerNominatedAt ?? deps.now()
  const posted = await pushSetupCard(deps, group, { owner, outcome: 'pending', nominatedAt, pendingOwnerName: ownerName })
  log('setup_card_resent', { groupId: group.groupId, posted })
  const result: SetupResendResult = { state: 'pending_owner', posted, ownerName }
  return { status: 200, body: result }
}

/** When `owner` was named, as the row holds it after this send's write: setup_group keeps
 *  the time while the nominee stays and sets this send's time for a new one. Read again
 *  rather than taken from the row loaded at the start, which is stale when another send
 *  changed the nominee in between. A failed read, or a row that already names someone
 *  else, gives this send's time: a fresh key can only repeat a card, never lose one. */
async function storedNominationTime(deps: Deps, groupId: string, owner: string, at: Date): Promise<Date> {
  try {
    const saved = await deps.store.getGroupSetup(groupId)
    if (saved?.nominatedOwnerLineUserId === owner && saved.ownerNominatedAt) return saved.ownerNominatedAt
  } catch (err) {
    logError('setup_nomination_read_failed', { groupId }, err)
  }
  return at
}
