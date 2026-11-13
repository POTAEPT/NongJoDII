import { type GroupPushResult, pushToGroupWithinBudget, retryKeyFrom } from '@/server/line/push-budget'
import { log, logError } from '@/server/log'
import type { Deps, TaskCounts, UnownedTask, WeeklySummaryGroup } from '@/server/ports'
import { bangkokIsoWeekday, bangkokTodayLabel, bangkokWeekStartLabel, isWeeklyDue } from '@/server/time/bangkok'
import type { TickJob } from '@/server/tick/run-tick'
import { shouldPostWeeklyInsight, weeklyInsightCard } from './card'

// Weekly insight (#10). #20: on the group's chosen weekday and time, count its Tasks in
// code (no AI call, decided 2026-11-11) and keep the result in weekly_insights. #21: post
// it to the group as a card. #22 shows it on the Dashboard.

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

/** The saved insight, or null when this week already had one (another run saved it). */
async function buildAndSave(deps: Deps, group: WeeklySummaryGroup, now: Date): Promise<WeeklyInsight | null> {
  const insight = await buildWeeklyInsight(deps, group, now)
  // One row per group and week (unique key): a concurrent or repeated run cannot add a second.
  const { inserted } = await deps.store.saveWeeklyInsight({
    groupId: insight.groupId, weekStart: insight.weekStart, counts: insight.counts, createdAt: now,
  })
  if (!inserted) return null
  log('weekly_insight_saved', {
    groupId: group.groupId, weekStart: insight.weekStart,
    done: insight.counts.done, inProcess: insight.counts.inProcess, awaitingOwner: insight.counts.awaitingOwner,
  })
  return insight
}

/** Share of the monthly LINE quota the weekly post leaves for pushes that matter more
 *  (reminders, Owner and member cards); the same as the Tasks-created announce. */
export const WEEKLY_PUSH_RESERVE = 0.1

export type WeeklyPostResult = 'empty' | GroupPushResult

/** #21: posts a saved insight to its group. Runs only for the run that saved the row, so a
 *  group gets at most one post per week; the retry key keeps LINE from sending it twice if
 *  the same post is retried. A group with no Tasks gets nothing. Skipped near the quota or
 *  failed: posted_at stays null and the insight shows on the Dashboard only (#22). Never
 *  throws: the insight is already saved. */
export async function postWeeklyInsight(deps: Deps, insight: WeeklyInsight, now: Date): Promise<WeeklyPostResult> {
  if (!shouldPostWeeklyInsight(insight)) {
    log('weekly_insight_not_posted', { groupId: insight.groupId, reason: 'no_tasks' })
    return 'empty'
  }
  let groupName: string | null = null
  try {
    groupName = (await deps.store.getGroupById(insight.groupId))?.name ?? null
  } catch (err) {
    // The card reads fine without the name.
    logError('weekly_insight_group_name_failed', { groupId: insight.groupId }, err)
  }
  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'weekly_insight',
    groupId: insight.groupId,
    lineGroupId: insight.lineGroupId,
    messages: [weeklyInsightCard({ insight, groupName, liffId: deps.config.liffId })],
    reserve: WEEKLY_PUSH_RESERVE,
    retryKey: retryKeyFrom(`weekly_insight:${insight.groupId}:${insight.weekStart}`),
  })
  if (result === 'pushed') {
    await deps.store.markWeeklyInsightPosted(insight.groupId, insight.weekStart, now)
      .catch((err) => logError('weekly_insight_mark_posted_failed', { groupId: insight.groupId }, err))
    log('weekly_insight_posted', { groupId: insight.groupId, weekStart: insight.weekStart })
  }
  return result
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
    let insight: WeeklyInsight | null
    try {
      insight = await buildAndSave(deps, group, now)
    } catch (err) {
      try {
        await deps.store.releaseWeeklySummary(group.groupId, today, group.lastSentOn)
      } catch (releaseErr) {
        // The recovery path above picks this group up on a later tick today.
        logError('weekly_insight_release_failed', { groupId: group.groupId }, releaseErr)
      }
      throw err
    }
    if (!insight) return 'already_this_week'
    // After the save and outside the claim: a failed post never undoes the insight.
    await postWeeklyInsight(deps, insight, now)
    return 'saved'
  }

  const slotReachedToday = isWeeklyDue({ ...slot, lastSentOn: null }, now)
  if (slotReachedToday && group.lastSentOn === today) {
    if (await deps.store.hasWeeklyInsight(group.groupId, bangkokWeekStartLabel(now))) return 'not_due'
    log('weekly_insight_recovering', { groupId: group.groupId })
    const insight = await buildAndSave(deps, group, now)
    if (!insight) return 'already_this_week'
    await postWeeklyInsight(deps, insight, now)
    return 'recovered'
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
