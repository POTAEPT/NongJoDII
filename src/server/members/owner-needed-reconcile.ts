import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { log, logError } from '../log'
import type { TickJob } from '../tick/run-tick'
import { postOwnerNeededCard } from './owner-left'

// #30 part A review (#74): the Owner leave touches three places that can fail apart.
//   1. The membership mark (recordMemberLeft) and the Owner mark (markOwnerLeftOnLeave) are
//      separate writes. The leave webhook retries both on LINE's redelivery, but the daily
//      member check (#32) does not ask a left Member again, so an Owner mark that failed
//      after the membership write was lost.
//   2. The owner_needed card is posted only by the member_left job (members/left.ts). A job
//      lost after ingest (the request ended, a crash) left the group paused with no card.
// Each tick this job reconciles both: a confirmed Owner whose membership is marked left
// gets the Owner mark (owner_left_at = the leave time); then every paused group with no
// open owner_needed card gets one (postOwnerNeededCard: one open card per group, one push
// inside the push budget). Both steps are idempotent.

/** LINE steps of one card, as checkTime counts them: member count and quota, then the push. */
const OWNER_CARD_CALLS = 2

export const ownerNeededReconcileJob: TickJob = {
  name: 'owner_needed_reconcile',
  async run(deps, now) {
    for (const o of await deps.store.listConfirmedOwnersWhoLeft()) {
      try {
        const { updated } = await deps.store.markOwnerLeft({ groupId: o.groupId, lineUserId: o.lineUserId, at: o.leftAt })
        if (updated) log('owner_left', { groupId: o.groupId, reconciled: true })
      } catch (err) {
        logError('owner_left_reconcile_failed', { groupId: o.groupId }, err)
      }
    }
    const groups = await deps.store.listGroupsWithoutOwnerCard()
    const deadline = driveDeadline(now)
    for (const [i, g] of groups.entries()) {
      try {
        checkTime(deps, deadline, OWNER_CARD_CALLS)
      } catch (err) {
        if (!(err instanceof DriveTimeUp)) throw err
        log('owner_needed_reconcile_incomplete', { groupsLeft: groups.length - i })
        return
      }
      try {
        await postOwnerNeededCard(deps, { groupId: g.groupId, lineGroupId: g.lineGroupId, ownerLineUserId: g.ownerLineUserId })
      } catch (err) {
        logError('owner_needed_reconcile_failed', { groupId: g.groupId }, err)
      }
    }
  },
}
