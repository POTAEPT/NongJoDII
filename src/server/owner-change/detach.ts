import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log } from '../log'
import { postOwnerNeededCard } from '../members/owner-left'
import type { Deps, DetachedSubGroup } from '../ports'
import type { TickJob } from '../tick/run-tick'
import { detachedCard } from './card'

// #31 Sub groups that are not taken over detach from the Project and need their own setup
// and Owner. #30 part B: either way (the new Owner's "detach" answer or the 7-day expiry) a
// detached group has no confirmed Owner, so its owner_left_at starts a fresh 7-day count and
// it gets the owner_needed card (a Drive-gated Owner, then the bot leaves after 7 days). A detached group keeps its
// old nominee unconfirmed and no Project, so the #52 form is open for it again.

/** How long a Sub group waits paused for the take-over answer (decided 2026-11-11). */
export const TAKEOVER_WAIT_MS = 7 * 86_400_000

/** Share of the monthly quota the card leaves unspent, like the setup card's. */
export const DETACHED_PUSH_RESERVE = 0.02

/** The LINE steps of one card, as checkTime counts them: the member count and quota reads
 *  run together, then the push. */
const DETACHED_CARD_CALLS = 2

/** One card per detached Sub group, by `deadline`. Best effort: the detach is already
 *  saved, and a card skipped (time up, quota, failure) is not sent again; the group's
 *  next Summary request answers with the setup card too. Never throws. */
export async function announceDetached(
  deps: Deps, groups: DetachedSubGroup[], deadline: Date, at: Date, card: 'setup' | 'owner_needed' = 'setup',
): Promise<void> {
  let sent = 0
  for (const [i, g] of groups.entries()) {
    try {
      checkTime(deps, deadline, DETACHED_CARD_CALLS)
    } catch (err) {
      if (!(err instanceof DriveTimeUp)) throw err
      log('subgroup_detached_cards_incomplete', { skipped: groups.length - i })
      break
    }
    if (card === 'owner_needed') {
      // #30 part B: the owner_needed card (one per detach: its retry key carries `at`).
      const owner = g.nominatedOwnerLineUserId ?? null
      const result = owner === null ? 'no_owner' : await postOwnerNeededCard(deps, {
        groupId: g.groupId, lineGroupId: g.lineGroupId, ownerLineUserId: owner, renewedAt: at,
      })
      if (result === 'pushed') sent++
      log('subgroup_detached_card', { groupId: g.groupId, result })
      continue
    }
    const result = await pushToGroupWithinBudget(deps, {
      purpose: 'subgroup_detached', groupId: g.groupId, lineGroupId: g.lineGroupId,
      messages: [detachedCard({ liffId: deps.config.liffId, groupId: g.groupId })],
      reserve: DETACHED_PUSH_RESERVE,
      retryKey: retryKeyFrom(`subgroup_detached:${g.groupId}:${at.toISOString()}`),
    })
    if (result === 'pushed') sent++
    log('subgroup_detached_card', { groupId: g.groupId, result })
  }
  log('subgroup_detached', { groups: groups.length, cards: sent })
}

/** Tick job: Sub groups whose take-over question waited 7 days detach in one statement
 *  (detachExpiredTakeovers), before any push, so a tick that runs short never leaves a
 *  group half done. The cards follow under the tick's deadline.
 *  #30 part B: such a group has no confirmed Owner, so the same statement sets owner_left_at
 *  to the detach time and the card is the owner_needed card: a Member takes the role with
 *  LINE login and Drive, and with no new Owner 7 days after the detach the bot leaves
 *  (ownerExitJob). Without the reset, a group whose Owner left long before would be left by
 *  the bot in the same tick. */
export const takeoverExpiryJob: TickJob = {
  name: 'subgroup_takeover_expiry',
  async run(deps, now) {
    const detached = await deps.store.detachExpiredTakeovers(new Date(now.getTime() - TAKEOVER_WAIT_MS), now)
    if (detached.length === 0) return
    await announceDetached(deps, detached, driveDeadline(now), now, 'owner_needed')
  },
}
