import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { isCardRetryTick } from '../line/card-retry'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log, logError } from '../log'
import type { Deps } from '../ports'
import type { TickJob } from '../tick/run-tick'
import { OWNER_NEEDED_PUSH_RESERVE, ownerNeededCard, postOwnerNeededCard } from './owner-left'

// #30 part A review (#74): the Owner leave touches several writes that can fail apart, and
// the owner_needed card was posted once, by the member_left job. Each tick this job puts
// right what a failure left behind, in three steps:
//   1. Lost Owner mark. The membership mark (recordMemberLeft) and the Owner mark
//      (markOwnerLeftOnLeave) are separate writes, and the daily member check (#32) does not
//      ask a left Member again. A confirmed Owner whose membership is marked left at or after
//      the confirm gets owner_left_at = now (the group gets its full 7 days before
//      ownerExitJob) and the card.
//   2. Lost card. A paused group (owner_left_at set, no confirmed Owner, the bot in it)
//      with no open owner_needed card gets one (postOwnerNeededCard: one open card per
//      group). For example the member_left job was lost after ingest.
//   3. Card not sent. An open card with no owner_needed push since it opened (skipped near
//      the quota, or refused by LINE) is pushed again under its own retry key, only on the
//      retry ticks of line/card-retry.ts (15 min, 2 h and 24 h after it opened).
// Every step is idempotent.
// Known gap (review of PR #95): a detach re-posts the card on the group's card that is
// still open (postOwnerNeededCard with renewedAt). Step 3 reads "pushed" and the retry
// ticks from when that card first opened, so if the first push went out days ago, a
// renewed push skipped near the quota or refused by LINE is not tried again. The group
// still reaches the Owner page through the Summary command's reply.

/** LINE steps of one card, as checkTime counts them: member count and quota, then the push. */
const OWNER_CARD_CALLS = 2

/** Pushes the group's open owner_needed card again, under the key it was first pushed with. */
async function repushOwnerCard(deps: Deps, g: { groupId: string; lineGroupId: string; promptId: string }) {
  return pushToGroupWithinBudget(deps, {
    purpose: 'owner_needed', groupId: g.groupId, lineGroupId: g.lineGroupId,
    messages: [ownerNeededCard(deps.config.liffId, g.groupId)],
    reserve: OWNER_NEEDED_PUSH_RESERVE,
    retryKey: retryKeyFrom(`owner_needed:${g.promptId}`),
  })
}

export const ownerNeededReconcileJob: TickJob = {
  name: 'owner_needed_reconcile',
  async run(deps, now) {
    const deadline = driveDeadline(now)
    const timeUp = (step: string, left: number): boolean => {
      try {
        checkTime(deps, deadline, OWNER_CARD_CALLS)
        return false
      } catch (err) {
        if (!(err instanceof DriveTimeUp)) throw err
        log('owner_needed_reconcile_incomplete', { step, left })
        return true
      }
    }

    // 1. Lost Owner mark: time for the card first, so a mark never goes without its card.
    const owners = await deps.store.listConfirmedOwnersWhoLeft()
    for (const [i, o] of owners.entries()) {
      if (timeUp('owner_mark', owners.length - i)) return
      try {
        const { updated } = await deps.store.markOwnerLeft({ groupId: o.groupId, lineUserId: o.lineUserId, at: now })
        if (!updated) continue
        log('owner_left', { groupId: o.groupId, reconciled: true })
        await postOwnerNeededCard(deps, { groupId: o.groupId, lineGroupId: o.lineGroupId, ownerLineUserId: o.lineUserId })
      } catch (err) {
        logError('owner_left_reconcile_failed', { groupId: o.groupId }, err)
      }
    }

    // 2 and 3. Read after step 1, so a group it just handled shows its new card.
    const paused = await deps.store.listPausedOwnerCards()
    const work = paused.filter((g) => g.card === null || (!g.card.pushed && isCardRetryTick(g.card.askedAt, now)))
    for (const [i, g] of work.entries()) {
      if (timeUp('owner_card', work.length - i)) return
      try {
        if (g.card === null) {
          const result = await postOwnerNeededCard(deps, { groupId: g.groupId, lineGroupId: g.lineGroupId, ownerLineUserId: g.ownerLineUserId })
          log('owner_needed_card_reconciled', { groupId: g.groupId, result })
        } else {
          const result = await repushOwnerCard(deps, { groupId: g.groupId, lineGroupId: g.lineGroupId, promptId: g.card.promptId })
          log('owner_needed_card_retry', { groupId: g.groupId, result })
        }
      } catch (err) {
        logError('owner_needed_reconcile_failed', { groupId: g.groupId }, err)
      }
    }
  },
}
