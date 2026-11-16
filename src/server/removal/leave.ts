import { log } from '../log'
import type { Deps } from '../ports'

// #11: the bot leaves a group by itself. LINE's docs do not say a `leave` event follows a
// leave the bot makes, so the 7-day deletion mark is set as soon as LINE accepts the call.
// A leave event that does arrive later finds the mark set and changes nothing (markBotLeft
// writes only where left_at is null). A re-invite inside the 7 days clears the mark
// (markBotJoined, at the join event); the daily purge (purge.ts) deletes the rest.

/** How long a group's data is kept after the bot left it. */
export const BOT_DELETE_AFTER_MS = 7 * 86_400_000

/** Why the bot leaves: Stop using in Settings (#11), or no confirmed Owner 7 days after the
 *  Owner left (#30 part B). Logged only; the deletion rule is the same for both. */
export type BotLeaveReason = 'stop_using' | 'no_owner'

/**
 * - left: LINE accepted the leave call; the group is marked.
 * - not_in_group: LINE answered 404 (the bot was already out, for example an earlier call
 *   went through but its answer was lost); the group is marked all the same.
 * - already_left: the group was already marked; LINE was not called.
 * - unknown_group: no group has this ID; nothing was called or written.
 * deleteAfter: the delete date the group holds afterwards. An existing date never moves.
 */
export type BotLeaveResult = {
  outcome: 'left' | 'not_in_group' | 'already_left' | 'unknown_group'
  /** Null only for unknown_group. */
  deleteAfter: Date | null
}

/**
 * The one way the bot leaves a group by itself. Shared by Stop using (#11) and the 7-day
 * no-Owner rule (#30 part B).
 *
 * Contract:
 * - `groupId` is groups.id; `now` is the leave time the caller uses (deps.now() for a
 *   request, the tick's `now` for a tick job). On success left_at = now and
 *   delete_after = now + 7 days, unless the group already had a mark, which stays.
 * - Throws when LINE's answer is not 200 or 404 (a 5xx, a timeout): nothing is marked and
 *   the bot may still be in the group, so the caller may retry later. Throws when the
 *   store fails after LINE accepted, or the mark matched no row (deleteAfter would be
 *   null): the bot is out with no mark yet; a retry gets 404 (not_in_group) and marks
 *   it, so callers retry on the next run. A success always carries a deleteAfter.
 * - Posts nothing to the group and touches no Drive file.
 */
export async function botLeaveGroup(
  deps: Deps,
  p: { groupId: string; reason: BotLeaveReason; now: Date },
): Promise<BotLeaveResult> {
  const { groupId, reason, now } = p
  const group = await deps.store.getGroupById(groupId)
  if (!group) return { outcome: 'unknown_group', deleteAfter: null }
  const marked = await deps.store.getGroupDeleteAfter(groupId)
  if (marked) return { outcome: 'already_left', deleteAfter: marked }
  const outcome = await deps.line.leaveGroup(group.lineGroupId)
  const { deleteAfter } = await deps.store.markBotLeft({ lineGroupId: group.lineGroupId, at: now })
  // LINE let the bot out but no row holds a delete date (the row went, or a newer join
  // stamp blocked the mark): not a success. The caller retries; LINE then answers 404 and
  // the mark is tried again.
  if (deleteAfter === null) throw new Error('bot_leave_unmarked')
  log('bot_left_group', { groupId, reason, outcome })
  return { outcome, deleteAfter }
}
