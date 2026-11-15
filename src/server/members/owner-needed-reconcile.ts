import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { log, logError } from '../log'
import type { TickJob } from '../tick/run-tick'
import { postOwnerNeededCard } from './owner-left'

// #30 part A review (#74): the membership mark (recordMemberLeft) and the Owner mark
// (markOwnerLeftOnLeave) are separate writes. The leave webhook retries both on LINE's
// redelivery, but the daily member check (#32) does not ask a left Member again, so an
// Owner mark that failed after the membership write was lost: the group kept a confirmed
// Owner who is gone. Each tick this job finds a confirmed Owner whose membership is marked
// left, sets owner_left_at (now, so the group gets its full 7 days before ownerExitJob)
// and posts that group's owner_needed card (one open card per group, one push inside the
// push budget). Idempotent: once marked, the Owner is no longer confirmed and not listed.
//
// Not covered here: a paused group whose owner_needed card never opened (the member_left
// job lost after ingest). A general sweep for that conflicts with test/owner-exit.test.ts
// fixtures, which seed owner_left_at without a card; see the PR notes.

/** LINE steps of one card, as checkTime counts them: member count and quota, then the push. */
const OWNER_CARD_CALLS = 2

export const ownerNeededReconcileJob: TickJob = {
  name: 'owner_needed_reconcile',
  async run(deps, now) {
    const owners = await deps.store.listConfirmedOwnersWhoLeft()
    const deadline = driveDeadline(now)
    for (const [i, o] of owners.entries()) {
      try {
        // Time for the card first, so a mark never goes without its card.
        checkTime(deps, deadline, OWNER_CARD_CALLS)
      } catch (err) {
        if (!(err instanceof DriveTimeUp)) throw err
        log('owner_left_reconcile_incomplete', { groupsLeft: owners.length - i })
        return
      }
      try {
        const { updated } = await deps.store.markOwnerLeft({ groupId: o.groupId, lineUserId: o.lineUserId, at: now })
        if (!updated) continue
        log('owner_left', { groupId: o.groupId, reconciled: true })
        await postOwnerNeededCard(deps, { groupId: o.groupId, lineGroupId: o.lineGroupId, ownerLineUserId: o.lineUserId })
      } catch (err) {
        logError('owner_left_reconcile_failed', { groupId: o.groupId }, err)
      }
    }
  },
}
