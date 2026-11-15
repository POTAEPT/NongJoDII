import { syncDriveForOwner } from '../google/drive-folders'
import { log } from '../log'
import type { ApiResult, CompleteOwnerChangeOutcome, Defer, Deps, GroupSetup } from '../ports'
import type { OwnerConfirmResult } from './types'

// #30 part A: a new Owner after the Owner left the main group (members/owner-left.ts).
//
// The owner_needed card's button opens the LIFF Owner page (`owner` view), which posts to
// /api/setup/confirm-owner like the #2e confirm (setup/confirm.ts routes groups whose Owner
// left here). The role changes in two steps, and takes effect only after both:
//   1. LINE login: the presser's verified LIFF login. The first live Member to press becomes
//      the main group's nominee (claimOwnerChange); anyone else then gets not_nominee, until
//      that person leaves the group, which frees the nomination again.
//   2. Drive connection: the nominee's latest Google sign-in is valid. Checked inside
//      complete_owner_change, which then runs the change in one transaction: the nominee
//      becomes the Project's owner and the main group's confirmed Owner (owner_left_at is
//      cleared, so file saving and the weekly insight resume), the old Drive connection is
//      retired as history and the folder IDs are cleared. Files already saved stay in the old
//      Owner's Drive. The Drive run that follows makes the new Owner's folders.
// Step 2 runs from both places that can finish it: this page (the nominee had a Google
// sign-in already) and the Google callback (google/callback.ts), after a sign-in. Running it
// twice changes nothing the second time.

/** POST /api/setup/confirm-owner for a group whose Owner left. `group` and `requester` come
 *  from openSetupGroup (verified LIFF user, live Member). */
export async function takeOverOwner(
  deps: Deps, group: GroupSetup, requester: string, defer: Defer, deadline: Date,
): Promise<ApiResult> {
  const { outcome: claim } = await deps.store.claimOwnerChange(group.groupId, requester, deps.now())
  if (claim === 'taken') return { status: 403, body: { error: 'not_nominee' } }
  // The Owner left a Sub group: its Owner must stay the Project's owner (check_same_owner).
  if (claim === 'not_main_group') return { status: 409, body: { error: 'sub_group' } }
  if (claim === 'claimed') log('owner_claimed', { groupId: group.groupId })
  // 'not_pending' still asks: the requester may have finished the change a moment ago.
  const outcome = await applyOwnerChange(deps, group.groupId, requester, defer)
  if (outcome === 'changed') defer(() => syncDriveForOwner(deps, requester, deadline))
  return answer(outcome)
}

function answer(outcome: CompleteOwnerChangeOutcome): ApiResult {
  const ok = (body: OwnerConfirmResult): ApiResult => ({ status: 200, body })
  switch (outcome) {
    case 'changed': return ok({ state: 'confirmed', alreadyConfirmed: false })
    case 'already_owner': return ok({ state: 'confirmed', alreadyConfirmed: true })
    case 'needs_drive': return ok({ state: 'needs_drive' })
    case 'not_nominee': return { status: 403, body: { error: 'not_nominee' } }
    case 'not_member': return { status: 403, body: { error: 'forbidden' } }
    case 'not_pending': return { status: 409, body: { error: 'setup_closed' } }
  }
}

/** Step 2 for one main group. On 'changed' it calls onMainGroupOwnerChanged. The caller
 *  defers the Drive run. Throws on a store failure. */
export async function applyOwnerChange(deps: Deps, groupId: string, lineUserId: string, defer: Defer): Promise<CompleteOwnerChangeOutcome> {
  const { outcome } = await deps.store.completeOwnerChange(groupId, lineUserId, deps.now())
  log('owner_change', { groupId, outcome })
  if (outcome === 'changed') {
    const projectId = (await deps.store.getGroupById(groupId))?.projectId ?? null
    if (projectId !== null) await onMainGroupOwnerChanged(deps, { projectId, groupId, ownerLineUserId: lineUserId }, defer)
  }
  return outcome
}

/** The Google callback, after the sign-in is stored: finishes every Owner change this person
 *  is the pending nominee of. The callback then runs the Drive work for them (as Owner of
 *  the changed Projects too). Throws on a store failure, so the page says to try again. */
export async function completePendingOwnerChanges(deps: Deps, lineUserId: string, defer: Defer): Promise<void> {
  for (const groupId of await deps.store.listPendingOwnerChanges(lineUserId)) {
    await applyOwnerChange(deps, groupId, lineUserId, defer)
  }
}

/** The main group's Owner changed (complete_owner_change ran). That transaction already
 *  started the take-over question for every attached Sub group (takeover_asked_at set, Sub
 *  groups paused, still naming their old Owner).
 *
 *  Hook for #31 (Sub group take-over): ask the new Owner whether to take over the Project's
 *  Sub groups and answer it with answer_subgroup_takeover. Until #31 lands it only logs. */
export async function onMainGroupOwnerChanged(
  deps: Deps, change: { projectId: string; groupId: string; ownerLineUserId: string }, defer: Defer,
): Promise<void> {
  // #31 asks the take-over question with deps and defer.
  void deps
  void defer
  log('main_group_owner_changed', { projectId: change.projectId, groupId: change.groupId })
}
