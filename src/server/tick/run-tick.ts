import { log, logError } from '@/server/log'
import type { Deps } from '@/server/ports'

/** One piece of work the 15-minute tick runs. `now` is read once per tick, so every
 *  job of one tick sees the same instant. A job decides for itself what is due (for
 *  example with isDailyDue / isWeeklyDue) and claims it in the database before sending. */
export type TickJob = { name: string; run(deps: Deps, now: Date): Promise<void> }

/** The jobs every tick runs, in order. Empty until the features land:
 *  daily reminders and gap flags (#8), the weekly insight (#20), the purge and the
 *  7-day Owner rules (#11, #30, #31) and the daily member check (#32). */
export const TICK_JOBS: TickJob[] = []

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
