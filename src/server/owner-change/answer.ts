import { driveDeadline, syncDriveForOwner } from '../google/drive-folders'
import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import { log } from '../log'
import type { ApiResult, Defer, Deps, OwnerChangeState } from '../ports'
import { badRequest, field } from '../review/load'
import { announceDetached, TAKEOVER_WAIT_MS } from './detach'
import type { TakeoverAnswerResult, TakeoverChoice, TakeoverLoad } from './types'

// #31 Project Owner change, step 2: the new Owner answers the take-over question in the
// LIFF view 'takeover' (opened from the main group's card; `groupId` is the main group's
// groups.id). Take over: the waiting Sub groups name the new Owner and are confirmed, so
// their plan, Fair-use cap and Drive follow; their folder IDs are cleared and the new
// Owner's Drive gets new folders, while old files stay in the old Owner's Drive. Detach:
// they leave the Project and each gets the owner_needed card (#30 part B).
//
// Only the Project's owner (projects.owner_line_user_id) may answer, as
// answer_subgroup_takeover itself acts for that person. While a further Owner change is
// pending (the main group names someone who has not confirmed yet), that is still the
// Owner who confirmed last.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Verified LIFF user (401), UUID groupId (400), a main group in a Project (404), a live
 *  Member of it (403) who is the Project's owner (403 not_owner). */
async function openTakeover(
  deps: Deps,
  body: unknown,
): Promise<{ ok: true; requester: string; change: OwnerChangeState } | { ok: false; result: ApiResult }> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }
  const groupId = field(body, 'groupId')
  if (typeof groupId !== 'string' || !UUID.test(groupId)) return { ok: false, result: badRequest('groupId') }
  const notFound = { ok: false as const, result: { status: 404, body: { error: 'not_found' } } }
  const group = await deps.store.getGroupById(groupId)
  if (!group?.projectId) return notFound
  const change = await deps.store.getOwnerChange(group.projectId)
  const main = change?.mainGroup
  if (!change || !main || main.groupId !== groupId) return notFound
  const allowed = await ensureGroupAccess(deps, { groupId: main.groupId, lineGroupId: main.lineGroupId, lineUserId: user.lineUserId })
  if (!allowed) return { ok: false, result: { status: 403, body: { error: 'forbidden' } } }
  if (user.lineUserId !== change.ownerLineUserId) return { ok: false, result: { status: 403, body: { error: 'not_owner' } } }
  return { ok: true, requester: user.lineUserId, change }
}

/** POST /api/takeover/load */
export async function loadTakeover(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openTakeover(deps, body)
  if (!gate.ok) return gate.result
  const { change } = gate
  // change_project_owner asks every Sub group at once, so the first ask time is theirs.
  const askedAt = change.waiting.reduce<Date | null>((min, g) => (min === null || g.askedAt < min ? g.askedAt : min), null)
  const view: TakeoverLoad = {
    mainGroupName: change.mainGroup?.name ?? null,
    subGroups: change.waiting.map((g) => ({ groupId: g.groupId, name: g.name })),
    detachAt: askedAt ? new Date(askedAt.getTime() + TAKEOVER_WAIT_MS).toISOString() : null,
  }
  return { status: 200, body: view }
}

/** POST /api/takeover/answer { idToken, groupId, choice }. The answer covers every Sub
 *  group still waiting when it is saved. 409 nothing_waiting: none waits (answered before,
 *  or detached after 7 days); 409 expired: the 7 days are over and the tick has not
 *  detached them yet (they detach, the answer is refused); 409 changed: one detached while
 *  this was saved (nothing written; the page loads again). */
export async function answerTakeover(deps: Deps, body: unknown, defer: Defer): Promise<ApiResult> {
  // The route's 60 s cover this handler and its after() work.
  const deadline = driveDeadline(deps.now())
  const choice = field(body, 'choice')
  if (choice !== 'takeover' && choice !== 'detach') return badRequest('choice')
  const gate = await openTakeover(deps, body)
  if (!gate.ok) return gate.result
  const { change, requester } = gate
  const waiting = change.waiting
  if (waiting.length === 0) return { status: 409, body: { error: 'nothing_waiting' } }
  const expired = { status: 409, body: { error: 'expired' } }
  const firstAsked = Math.min(...waiting.map((g) => g.askedAt.getTime()))
  if (firstAsked < deps.now().getTime() - TAKEOVER_WAIT_MS) return expired
  const ids = choice === 'takeover' ? waiting.map((g) => g.groupId) : []
  const { outcome } = await deps.store.answerSubgroupTakeover(change.projectId, ids)
  if (outcome === 'changed') return { status: 409, body: { error: 'changed' } }
  if (outcome === 'expired') return expired
  log('subgroup_takeover_answered', { projectId: change.projectId, choice, subGroups: waiting.length })
  const at = deps.now()
  if (choice === 'takeover') {
    // The new Owner's Drive gets the Sub groups' folders, if they have signed in to Google.
    defer(() => syncDriveForOwner(deps, requester, deadline))
  } else {
    // #30 part B: the detached groups have no confirmed Owner, so they start the owner_needed
    // flow (Drive-gated Owner, 7 days, then the bot leaves) and get its card.
    const started = await deps.store.startDetachedOwnerCount(waiting.map((g) => g.groupId), at)
    // Once the review-followups migration is applied, the rpc's detach already started the
    // count (its now() may equal or follow `at`, so `started` can be empty) and cleared the
    // nominee. Every waiting group detached in this answer, so each gets its card.
    const detached = waiting.map((g) => started.find((s) => s.groupId === g.groupId) ??
      { groupId: g.groupId, lineGroupId: g.lineGroupId, name: g.name, nominatedOwnerLineUserId: null })
    defer(() => announceDetached(deps, detached, deadline, at, 'owner_needed'))
  }
  const result: TakeoverAnswerResult = { choice: choice as TakeoverChoice, subGroups: waiting.length }
  return { status: 200, body: result }
}
