import { driveDeadline, syncDriveForOwner } from '../google/drive-folders'
import { log } from '../log'
import type { ApiResult, Defer, Deps } from '../ports'
import { openSetupGroup } from './load'
import type { OwnerConfirmResult } from './types'

/** POST /api/setup/confirm-owner, from the #2e card's button. Only the verified nominee
 *  confirms (their LIFF login is the LINE login); confirming creates the Project with this
 *  group as its main group. A repeat by the confirmed Owner answers 200 again. No push:
 *  the #2e card already told the group. An Owner already signed in to Google gets the
 *  Project's Drive folders (#13) after the response. */
export async function confirmOwner(deps: Deps, body: unknown, defer: Defer): Promise<ApiResult> {
  // The route's 60 s cover this handler and its after() work: the Drive work is timed from here.
  const deadline = driveDeadline(deps.now())
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  const { outcome } = await deps.store.confirmGroupOwner(group.groupId, requester, deps.now())
  if (outcome === 'not_nominee') return { status: 403, body: { error: 'not_nominee' } }
  if (outcome === 'not_member') return { status: 403, body: { error: 'forbidden' } }
  if (outcome === 'closed') return { status: 409, body: { error: 'setup_closed' } }
  if (outcome === 'confirmed') {
    log('owner_confirmed', { groupId: group.groupId })
    defer(() => syncDriveForOwner(deps, requester, deadline))
  }
  const result: OwnerConfirmResult = { state: 'confirmed', alreadyConfirmed: outcome === 'already_confirmed' }
  return { status: 200, body: result }
}
