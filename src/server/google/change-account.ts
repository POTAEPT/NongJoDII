import { log } from '../log'
import type { Deps } from '../ports'

// #14: change of the connected Google account. The Owner starts a normal Google sign-in
// (the LIFF Google view offers it). When the sign-in finishes with a Google account other
// than the one that holds a Project's active Drive connection, the old connection is
// retired and the Project's folder IDs are cleared, for every Project this person owns as
// confirmed Owner. The Drive run that follows (syncDriveForOwner) then claims each Project
// for the new account and makes new folders in the new Drive. Nothing in the old Drive is
// touched, and the retired row stays, so a saved file's drive_connection_id still tells
// which Drive holds it. A sign-in with the account that already holds the connection
// changes nothing.
//
// Not one transaction, but safely repeatable (StorePort.retireDriveConnection): the folder
// IDs are cleared first and the row is retired last, so a change that stopped part-way
// still shows an active row of the other account, and the next sign-in does it again. The
// callback answers 'failed' when this throws, so the Owner is told to try again.

/** Runs before the callback page is answered. Throws on a store failure. */
export async function retireOtherAccountConnections(deps: Deps, lineUserId: string, googleAccountId: string): Promise<void> {
  const projectIds = await deps.store.listConfirmedOwnerProjects(lineUserId)
  const at = deps.now()
  let projects = 0
  for (const projectId of projectIds) {
    if ((await deps.store.retireDriveConnection(projectId, googleAccountId, at)).retired) projects++
  }
  // IDs and a count only.
  if (projects > 0) log('drive_account_changed', { googleAccountId, projects })
}
