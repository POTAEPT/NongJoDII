import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { log, logError } from '../log'
import type { Deps, MemberCheckGroup } from '../ports'
import { bangkokTodayLabel, isDailyDue } from '../time/bangkok'
import type { TickJob } from '../tick/run-tick'
import { handleMemberLeft, recordMemberLeft } from './left'

// #32: the daily member check, a backup for lost memberLeft events. Once a Bangkok day, from
// MEMBER_CHECK_TIME, the tick asks LINE for the group member profile of each live Member of
// each set-up group. A 404 means the person left: the bot runs the same leave as the webhook
// (recordMemberLeft, then handleMemberLeft's one card). A profile reply changes nothing. Any
// other answer (5xx, 429, a timeout) marks nobody; tomorrow's run asks again. The check posts
// nothing else.
//
// The day is claimed per group like the daily reminder: a claim that expires, and the day
// marked checked only when every Member of the group was asked. Time is shared with the
// rest of the tick (driveDeadline of the tick's start, as the Drive jobs). A tick that runs
// short stops before a call it has no time for, clears its claim and leaves the group to
// the next tick, which asks again from the start; a Member it already marked left is no
// longer live, so they are not asked or handled twice.

/** The Bangkok time the check starts: daytime, so a leave card is seen, and before the
 *  default 09:00 reminder, so that day's reminders already show the released Tasks. */
export const MEMBER_CHECK_TIME = '08:00'

/** How long one attempt's claim holds the group: shorter than the 15-minute tick, as the
 *  daily reminder's, so the next tick can take over from a request that stopped. */
export const MEMBER_CHECK_CLAIM_TTL_MS = 10 * 60_000

/** LINE calls the leave card can make one after another: the quota and member count (run
 *  together), then the push. Kept free before each profile call, so a person is never marked
 *  left without time for their card: a later run would skip them, and the card would be lost. */
const CARD_CALLS = 2

export type MemberCheckResult = 'not_due' | 'claimed_elsewhere' | 'not_in_group' | 'checked'

/** One group, on one tick. Throws DriveTimeUp when the tick's time runs out; the claim is
 *  cleared first, so the next tick goes on. */
export async function runMemberCheckForGroup(
  deps: Deps, group: MemberCheckGroup, now: Date, deadline: Date,
): Promise<MemberCheckResult> {
  if (!isDailyDue({ time: MEMBER_CHECK_TIME, lastSentOn: group.lastCheckedOn }, now)) return 'not_due'
  const today = bangkokTodayLabel(now)
  const staleBefore = new Date(now.getTime() - MEMBER_CHECK_CLAIM_TTL_MS)
  if (!(await deps.store.claimMemberCheck(group.groupId, today, now, staleBefore)).claimed) return 'claimed_elsewhere'

  const { groupId, lineGroupId } = group
  let result: MemberCheckResult = 'checked'
  let members = 0
  let left = 0
  let errors = 0
  try {
    // LINE answers 404 for every member of a group the bot is no longer in. The bot's own
    // leave can be lost too (its handling belongs to #11), so ask about the group first and
    // mark nobody when LINE no longer knows it.
    checkTime(deps, deadline, 1)
    let inGroup = true
    try {
      inGroup = (await deps.line.getGroupSummary(lineGroupId)) !== null
    } catch (err) {
      errors++
      logError('member_check_group_failed', { groupId }, err)
    }
    if (errors > 0 || !inGroup) {
      if (!inGroup) result = 'not_in_group'
    } else {
      for (const m of await deps.store.listLiveMembers(groupId)) {
        checkTime(deps, deadline, 1 + CARD_CALLS)
        members++
        let profile: { displayName: string } | null
        try {
          profile = await deps.line.getGroupMemberProfile(lineGroupId, m.lineUserId)
        } catch (err) {
          errors++
          logError('member_check_profile_failed', { groupId }, err)
          continue
        }
        if (profile !== null) continue
        // Stamped with the tick's start, read before the call: a join that lands since is
        // newer and wins (markMemberLeft applies only a leave newer than the last event).
        const released = await recordMemberLeft(deps, { groupId, lineUserIds: [m.lineUserId], at: now })
        left++
        if (released.length === 0) continue
        try {
          // One card per person found; the key is theirs and the day's, so a retried tick
          // never posts it twice and two people's cards never share a key.
          await handleMemberLeft(deps, {
            kind: 'member_left', groupId, lineGroupId, released,
            eventId: `member_check:${groupId}:${m.lineUserId}:${today}`,
          })
        } catch (err) {
          logError('member_check_card_failed', { groupId }, err)
        }
      }
    }
  } catch (err) {
    await deps.store.releaseMemberCheck(groupId, now)
      .catch((e) => logError('member_check_release_failed', { groupId }, e))
    throw err
  }
  // If this write fails, the claim expires and a later tick checks the group again.
  await deps.store.finishMemberCheck(groupId, today, now)
  log('member_check', { groupId, result, members, left, errors })
  return result
}

/** Tick job: every set-up group whose check is due today. One group's failure is logged and
 *  never stops the others; running out of time stops them all, with one log line. */
export const memberCheckJob: TickJob = {
  name: 'member_check',
  async run(deps, now) {
    // Before the slot no group is due: skip the store read.
    if (!isDailyDue({ time: MEMBER_CHECK_TIME, lastSentOn: null }, now)) return
    const deadline = driveDeadline(now)
    const groups = await deps.store.listMemberCheckGroups()
    for (const [i, group] of groups.entries()) {
      try {
        await runMemberCheckForGroup(deps, group, now, deadline)
      } catch (err) {
        if (err instanceof DriveTimeUp) {
          // groupsLeft counts this group too.
          log('member_check_incomplete', { groupId: group.groupId, groupsLeft: groups.length - i })
          return
        }
        logError('member_check_failed', { groupId: group.groupId }, err)
      }
    }
  },
}
