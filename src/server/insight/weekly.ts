import { log, logError } from '@/server/log'
import type { Deps, TaskCounts, UnownedTask, WeeklySummaryGroup } from '@/server/ports'
import { bangkokIsoWeekday, bangkokTodayLabel, bangkokWeekStartLabel, isWeeklyDue } from '@/server/time/bangkok'
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

/** 'saved' and 'recovered' are the only results that wrote this week's row; #21 posts on them. */
export type WeeklyResult = 'not_due' | 'claimed_elsewhere' | 'saved' | 'recovered' | 'already_this_week'

async function buildAndSave(deps: Deps, group: WeeklySummaryGroup, now: Date): Promise<boolean> {
  const insight = await buildWeeklyInsight(deps, group, now)
  // One row per group and week (unique key): a concurrent or repeated run cannot add a second.
  const { inserted } = await deps.store.saveWeeklyInsight({
    groupId: insight.groupId, weekStart: insight.weekStart, counts: insight.counts, createdAt: now,
  })
  if (inserted) {
    log('weekly_insight_saved', {
      groupId: group.groupId, weekStart: insight.weekStart,
      done: insight.counts.done, inProcess: insight.counts.inProcess, awaitingOwner: insight.counts.awaitingOwner,
    })
  }
  return inserted
}

/** One group, on one tick:
 *  - Due (weekday and time reached, not done today): claim the day, then build and save.
 *    A failure releases the claim, so the next tick retries.
 *  - Already claimed today but this week has no row: an earlier tick claimed, then failed
 *    and could not release (for example while the database was down). Build and save again
 *    without a claim; the unique key still keeps one row per week. This also repairs a
 *    claim whose release failed, which no other path would. */
export async function runWeeklyInsightForGroup(deps: Deps, group: WeeklySummaryGroup, now: Date): Promise<WeeklyResult> {
  const today = bangkokTodayLabel(now)
  const slot = { weekday: group.weekday, time: group.time, lastSentOn: group.lastSentOn }

  if (isWeeklyDue(slot, now)) {
    if (!(await deps.store.claimWeeklySummary(group.groupId, today)).claimed) return 'claimed_elsewhere'
    try {
      return (await buildAndSave(deps, group, now)) ? 'saved' : 'already_this_week'
    } catch (err) {
      try {
        await deps.store.releaseWeeklySummary(group.groupId, today, group.lastSentOn)
      } catch (releaseErr) {
        // The recovery path above picks this group up on a later tick today.
        logError('weekly_insight_release_failed', { groupId: group.groupId }, releaseErr)
      }
      throw err
    }
  }

  const slotReachedToday = isWeeklyDue({ ...slot, lastSentOn: null }, now)
  if (slotReachedToday && group.lastSentOn === today) {
    if (await deps.store.hasWeeklyInsight(group.groupId, bangkokWeekStartLabel(now))) return 'not_due'
    log('weekly_insight_recovering', { groupId: group.groupId })
    return (await buildAndSave(deps, group, now)) ? 'recovered' : 'already_this_week'
  }
  return 'not_due'
}

/** Tick job: the groups whose weekly slot falls on today's Bangkok weekday. One group's
 *  failure is logged and never stops the others. */
export const weeklyInsightJob: TickJob = {
  name: 'weekly_insight',
  async run(deps, now) {
    const groups = await deps.store.listWeeklySummaryGroups(bangkokIsoWeekday(now))
    for (const group of groups) {
      try {
        await runWeeklyInsightForGroup(deps, group, now)
      } catch (err) {
        logError('weekly_insight_failed', { groupId: group.groupId }, err)
      }
    }
  },
}
