import { log, logError } from '@/server/log'
import type { Deps, TaskCounts, UnownedTask, WeeklySummaryGroup } from '@/server/ports'
import { bangkokTodayLabel, bangkokWeekStartLabel, isWeeklyDue } from '@/server/time/bangkok'
import type { TickJob } from '@/server/tick/run-tick'

// #20 Weekly insight, part 1: on the group's chosen weekday and time, count its Tasks in
// code (no AI call, decided 2026-11-11) and keep the result in weekly_insights. Posting
// it to the group is #21; showing it on the Dashboard is #22.

/** How many unowned Tasks the insight lists. */
export const UNOWNED_LIST_LIMIT = 10

export type WeeklyInsight = {
  groupId: string; lineGroupId: string; weekStart: string
  counts: TaskCounts; unowned: UnownedTask[]
}

/** The insight for one group as of `now`: counts and the unowned Tasks, read live. */
export async function buildWeeklyInsight(deps: Deps, group: WeeklySummaryGroup, now: Date): Promise<WeeklyInsight> {
  const [counts, unowned] = await Promise.all([
    deps.store.countTasksByStatus(group.groupId),
    deps.store.listUnownedTasks(group.groupId, UNOWNED_LIST_LIMIT),
  ])
  return { groupId: group.groupId, lineGroupId: group.lineGroupId, weekStart: bangkokWeekStartLabel(now), counts, unowned }
}

export type WeeklyResult = 'not_due' | 'claimed_elsewhere' | 'saved' | 'already_this_week'

/** One group: due check, claim, build, save. A failure after the claim releases it, so
 *  the next tick retries instead of losing this week's insight. */
export async function runWeeklyInsightForGroup(deps: Deps, group: WeeklySummaryGroup, now: Date): Promise<WeeklyResult> {
  if (!isWeeklyDue({ weekday: group.weekday, time: group.time, lastSentOn: group.lastSentOn }, now)) return 'not_due'
  const today = bangkokTodayLabel(now)
  if (!(await deps.store.claimWeeklySummary(group.groupId, today)).claimed) return 'claimed_elsewhere'
  try {
    const insight = await buildWeeklyInsight(deps, group, now)
    // Second guard: one row per group and week, even if the weekday changed mid-week.
    const { inserted } = await deps.store.saveWeeklyInsight({
      groupId: insight.groupId, weekStart: insight.weekStart, counts: insight.counts, createdAt: now,
    })
    if (!inserted) return 'already_this_week'
    log('weekly_insight_saved', {
      groupId: group.groupId, weekStart: insight.weekStart,
      done: insight.counts.done, inProcess: insight.counts.inProcess, awaitingOwner: insight.counts.awaitingOwner,
    })
    return 'saved'
  } catch (err) {
    await deps.store.releaseWeeklySummary(group.groupId, today, group.lastSentOn)
    throw err
  }
}

/** Tick job: every group whose weekly slot has come. One group's failure is logged and
 *  never stops the others. */
export const weeklyInsightJob: TickJob = {
  name: 'weekly_insight',
  async run(deps, now) {
    const groups = await deps.store.listWeeklySummaryGroups()
    for (const group of groups) {
      try {
        await runWeeklyInsightForGroup(deps, group, now)
      } catch (err) {
        logError('weekly_insight_failed', { groupId: group.groupId }, err)
      }
    }
  },
}
