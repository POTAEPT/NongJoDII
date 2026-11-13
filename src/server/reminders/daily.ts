import { type GroupPushResult, pushToGroupWithinBudget, retryKeyFrom } from '@/server/line/push-budget'
import { log, logError } from '@/server/log'
import type { DailyReminderGroup, Deps } from '@/server/ports'
import { bangkokTodayLabel, isDailyDue } from '@/server/time/bangkok'
import type { TickJob } from '@/server/tick/run-tick'
import { reminderCarousel } from './card'
import { selectReminders } from './select'

// #44 (8b) Daily reminders and gap flags. On the first tick at or after a group's daily
// reminder time: claim the day, pick the Tasks that need attention (select.ts), and post
// one carousel to the group where they live, never in a 1:1 chat (rules: Scheduling and
// pushes). A day with nothing to remind sends nothing. No AI call.

/** Share of the monthly LINE quota left unspent by the reminder post. Smaller than the
 *  weekly insight's and the Tasks-created announce's (10%): reminders are what the
 *  reserve is kept for. */
export const REMINDER_PUSH_RESERVE = 0.02

export type DailyResult = 'not_due' | 'claimed_elsewhere' | 'nothing_to_remind' | GroupPushResult

/** One group, on one tick. A failure before the push, or a push LINE rejects, releases the
 *  day's claim so the next tick retries; the retry key keeps LINE from sending the same
 *  day's post twice. A post skipped near the quota keeps the claim: the Tasks are on the
 *  Dashboard, and retrying every 15 minutes would only skip again. */
export async function runDailyRemindersForGroup(deps: Deps, group: DailyReminderGroup, now: Date): Promise<DailyResult> {
  if (!isDailyDue({ time: group.time, lastSentOn: group.lastSentOn }, now)) return 'not_due'
  const today = bangkokTodayLabel(now)
  if (!(await deps.store.claimDailyReminder(group.groupId, today)).claimed) return 'claimed_elsewhere'

  const release = () => deps.store.releaseDailyReminder(group.groupId, today, group.lastSentOn)
    .catch((e) => logError('daily_reminder_release_failed', { groupId: group.groupId }, e))

  let result: DailyResult
  try {
    const { items, total } = selectReminders(await deps.store.listReminderTasks(group.groupId), now)
    if (total === 0) {
      log('daily_reminder_nothing', { groupId: group.groupId })
      return 'nothing_to_remind'
    }
    const members = await deps.store.listLiveMembers(group.groupId)
    const names = new Map(members.map((m) => [m.lineUserId, m.displayName]))
    result = await pushToGroupWithinBudget(deps, {
      purpose: 'reminder',
      groupId: group.groupId,
      lineGroupId: group.lineGroupId,
      messages: [reminderCarousel({ items, total, names, now })],
      reserve: REMINDER_PUSH_RESERVE,
      retryKey: retryKeyFrom(`reminder:${group.groupId}:${today}`),
    })
  } catch (err) {
    await release()
    throw err
  }

  if (result === 'failed') await release()
  if (result === 'pushed') log('daily_reminder_posted', { groupId: group.groupId })
  return result
}

/** Tick job: every group whose daily slot has come. One group's failure is logged and never
 *  stops the others. */
export const dailyRemindersJob: TickJob = {
  name: 'daily_reminders',
  async run(deps, now) {
    const groups = await deps.store.listDailyReminderGroups()
    for (const group of groups) {
      try {
        await runDailyRemindersForGroup(deps, group, now)
      } catch (err) {
        logError('daily_reminder_failed', { groupId: group.groupId }, err)
      }
    }
  },
}
