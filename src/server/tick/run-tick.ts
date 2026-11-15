import { driveAccessCheckJob } from '@/server/google/access-check'
import { driveSetupJob } from '@/server/google/drive-folders'
import { weeklyInsightJob } from '@/server/insight/weekly'
import { log, logError } from '@/server/log'
import { memberCheckJob } from '@/server/members/daily-check'
import { takeoverExpiryJob } from '@/server/owner-change/detach'
import { takeoverCardRetryJob } from '@/server/owner-change/takeover-retry'
import type { Deps } from '@/server/ports'
import { dailyRemindersJob } from '@/server/reminders/daily'
import { purgeJob } from '@/server/removal/purge'

/** One piece of work the 15-minute tick runs. `now` is read once per tick, so every
 *  job of one tick sees the same instant. A job decides for itself what is due (for
 *  example with isDailyDue / isWeeklyDue) and claims it in the database before sending. */
export type TickJob = { name: string; run(deps: Deps, now: Date): Promise<void> }

/** The jobs every tick runs, in order: reminders first, as they spend the quota reserve the
 *  others leave; then the weekly insight; then the daily Drive access check (#14), which
 *  works on one tick a day; then the 7-day Sub group take-over rule (#31), whose detach is one
 *  statement and whose cards are best effort, and the lost take-over card's retry (#31);
 *  then the daily member check (#32), which goes
 *  on over later ticks when one runs short, so it comes after the jobs with no time check of
 *  their own; the daily purge (#11), on its own night slot; the Drive setup finisher (#13)
 *  last, as it sends nothing to LINE. The time-checked jobs stop on their own when the
 *  tick's time runs short. Still to come: the 7-day Owner-left rule (#30). */
export const TICK_JOBS: TickJob[] = [
  dailyRemindersJob, weeklyInsightJob, driveAccessCheckJob, takeoverExpiryJob, takeoverCardRetryJob, memberCheckJob,
  purgeJob, driveSetupJob,
]

/** Runs each job one after another. One job's failure is logged and never stops the
 *  ones after it. */
export async function runTick(deps: Deps, jobs: TickJob[] = TICK_JOBS): Promise<void> {
  const now = deps.now()
  let failed = 0
  for (const job of jobs) {
    try {
      await job.run(deps, now)
    } catch (err) {
      failed += 1
      logError('tick_job_failed', { job: job.name }, err)
    }
  }
  log('tick_done', { jobs: jobs.length, failed })
}
