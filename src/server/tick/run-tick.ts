import { driveSetupJob } from '@/server/google/drive-folders'
import { weeklyInsightJob } from '@/server/insight/weekly'
import { log, logError } from '@/server/log'
import type { Deps } from '@/server/ports'
import { dailyRemindersJob } from '@/server/reminders/daily'

/** One piece of work the 15-minute tick runs. `now` is read once per tick, so every
 *  job of one tick sees the same instant. A job decides for itself what is due (for
 *  example with isDailyDue / isWeeklyDue) and claims it in the database before sending. */
export type TickJob = { name: string; run(deps: Deps, now: Date): Promise<void> }

/** The jobs every tick runs, in order: reminders first, as they spend the quota reserve the
 *  others leave; then the weekly insight; the Drive setup finisher (#13) last, as it sends
 *  nothing to LINE and stops on its own when the tick's time runs short. Still to come:
 *  the purge and the 7-day Owner rules (#11, #30, #31) and the daily member check (#32). */
export const TICK_JOBS: TickJob[] = [dailyRemindersJob, weeklyInsightJob, driveSetupJob]

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
