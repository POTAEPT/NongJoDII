import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { openSetupGroup } from './load'
import type { OwnerConfirmResult } from './types'

/** POST /api/setup/confirm-owner, from the #2e card's button. Only the verified nominee
 *  confirms (their LIFF login is the LINE login); confirming creates the Project with this
 *  group as its main group. A repeat by the confirmed Owner answers 200 again. No push:
 *  the #2e card already told the group. */
export async function confirmOwner(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  const { outcome } = await deps.store.confirmGroupOwner(group.groupId, requester, deps.now())
  if (outcome === 'not_nominee') return { status: 403, body: { error: 'not_nominee' } }
  if (outcome === 'not_member') return { status: 403, body: { error: 'forbidden' } }
  if (outcome === 'closed') return { status: 409, body: { error: 'setup_closed' } }
  if (outcome === 'confirmed') log('owner_confirmed', { groupId: group.groupId })
  const result: OwnerConfirmResult = { state: 'confirmed', alreadyConfirmed: outcome === 'already_confirmed' }
  return { status: 200, body: result }
}
