import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { log, logError } from '../log'
import type { Deps, MemberCheckGroup, TaskRow } from '../ports'
import { bangkokTodayLabel, isDailyDue } from '../time/bangkok'
import type { TickJob } from '../tick/run-tick'
import { handleMemberLeft, recordMemberLeft } from './left'

// #32: the daily member check, a backup for lost memberLeft events. Once a Bangkok day, from
// MEMBER_CHECK_TIME, the tick asks LINE for the group member profile of each live Member of
// each group the bot is in (set up or not, as the memberLeft webhook). A 404 means the person
// left: the bot runs the same leave as the webhook (recordMemberLeft, then handleMemberLeft's
// one card). A profile reply changes nothing. Any other answer (5xx, 429, a timeout) marks
// nobody; tomorrow's run asks again. The check posts nothing else.
//
// The day is claimed per group like the daily reminder: a claim that expires, and the day
// marked checked only when every Member of the group was asked. Each Member asked is stamped
// for the day (member_checked_on), so a tick that runs short resumes with the Members not
// asked yet. Time is shared with the rest of the tick (driveDeadline of the tick's start, as
// the Drive jobs): a call starts only if it still ends in time.

/** The Bangkok time the check starts: daytime, so a leave card is seen, and before the
 *  default 09:00 reminder, so that day's reminders already show the released Tasks. */
export const MEMBER_CHECK_TIME = '08:00'

/** How long one attempt's claim holds the group: shorter than the 15-minute tick, as the
 *  daily reminder's, so the next tick can take over from a request that stopped. */
export const MEMBER_CHECK_CLAIM_TTL_MS = 10 * 60_000

/** LINE calls the leave card can make one after another: the quota and member count (run
 *  together), then the push. Kept free before a leave is written, so a person is never
 *  marked left without time for their card (a later run would skip them, and the card would
 *  be lost). Without the time, the tick stops and the next one asks again. */
const CARD_CALLS = 2

type Released = { lineUserId: string; tasks: TaskRow[] }[]
type Counts = { members: number; left: number; errors: number; repaired: number }

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
  const counts: Counts = { members: 0, left: 0, errors: 0, repaired: 0 }
  const card = async (lineUserId: string, released: Released) => {
    if (released.length === 0) return
    try {
      // One card per person, keyed on them and the day: a retried tick never posts it twice,
      // and two people's cards never share a key.
      await handleMemberLeft(deps, {
        kind: 'member_left', groupId, lineGroupId, released,
        eventId: `member_check:${groupId}:${lineUserId}:${today}`, ownerLeft: null,
      })
    } catch (err) {
      logError('member_check_card_failed', { groupId }, err)
    }
  }

  let result: MemberCheckResult = 'checked'
  try {
    // LINE may answer 404 for every member of a group the bot is no longer in, and the bot's
    // own leave event can be lost too (its handling belongs to #11). So ask about the group
    // first, and again before each leave, and mark nobody when LINE no longer knows it.
    const inGroup = await groupKnown(deps, groupId, lineGroupId, deadline, 0)
    if (inGroup === null) counts.errors++
    else if (!inGroup) result = 'not_in_group'
    else {
      await repairUnreleased(deps, groupId, deadline, card, counts)
      for (const lineUserId of await deps.store.listMembersToCheck(groupId, today)) {
        checkTime(deps, deadline, 1)
        counts.members++
        let profile: { displayName: string } | null
        try {
          profile = await deps.line.getGroupMemberProfile(lineGroupId, lineUserId)
        } catch (err) {
          counts.errors++
          logError('member_check_profile_failed', { groupId }, err)
          await deps.store.markMemberChecked(groupId, lineUserId, today) // asked again tomorrow
          continue
        }
        if (profile !== null) {
          await deps.store.markMemberChecked(groupId, lineUserId, today)
          continue
        }
        const still = await groupKnown(deps, groupId, lineGroupId, deadline, CARD_CALLS)
        if (still === null) {
          counts.errors++
          await deps.store.markMemberChecked(groupId, lineUserId, today)
          continue
        }
        if (!still) {
          result = 'not_in_group'
          break
        }
        // Stamped with the tick's start, read before the call: a join that lands since is
        // newer and wins (markMemberLeft applies only a leave newer than the last event).
        const released = await recordMemberLeft(deps, { groupId, lineUserIds: [lineUserId], at: now })
        counts.left++
        await card(lineUserId, released)
      }
    }
  } catch (err) {
    await deps.store.releaseMemberCheck(groupId, now)
      .catch((e) => logError('member_check_release_failed', { groupId }, e))
    throw err
  }
  // If this write fails, the claim expires and a later tick goes on with the group.
  await deps.store.finishMemberCheck(groupId, today, now)
  log('member_check', { groupId, result, ...counts })
  return result
}

/** true when LINE still knows the group, false on its 404, null on any other failure
 *  (logged). Starts only with time for this call and `reserve` more after it. */
async function groupKnown(
  deps: Deps, groupId: string, lineGroupId: string, deadline: Date, reserve: number,
): Promise<boolean | null> {
  checkTime(deps, deadline, 1 + reserve)
  try {
    return (await deps.line.getGroupSummary(lineGroupId)) !== null
  } catch (err) {
    logError('member_check_group_failed', { groupId }, err)
    return null
  }
}

/** A leave whose Task release failed after the mark (a store error between the two writes)
 *  leaves Tasks assigned to someone who is no longer live, and no later check asks about
 *  them. So each run first releases open Tasks whose assignee is not a live Member. */
async function repairUnreleased(
  deps: Deps, groupId: string, deadline: Date,
  card: (lineUserId: string, released: Released) => Promise<void>, counts: Counts,
): Promise<void> {
  const live = new Set((await deps.store.listLiveMembers(groupId)).map((m) => m.lineUserId))
  const stale = new Set<string>()
  for (const t of await deps.store.listReminderTasks(groupId)) {
    if (t.assigneeLineUserId !== null && !live.has(t.assigneeLineUserId)) stale.add(t.assigneeLineUserId)
  }
  for (const lineUserId of stale) {
    checkTime(deps, deadline, CARD_CALLS)
    // One database step that releases only while the person is not live.
    const tasks = await deps.store.releaseTasksIfLeft({ groupId, lineUserId })
    if (tasks.length === 0) continue
    counts.repaired++
    await card(lineUserId, [{ lineUserId, tasks }])
  }
}

/** Tick job: every group whose check is due today. One group's failure is logged and never
 *  stops the others; running out of time stops them all, with one log line. */
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
