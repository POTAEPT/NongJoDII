import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { log, logError } from '../log'
import type { TickJob } from '../tick/run-tick'
import { bangkokParts, parseTimeOfDay } from '../time/bangkok'

// #11: the daily purge. Once a Bangkok day it deletes the groups whose delete date
// (groups.delete_after, 7 days after the bot left) has passed. The delete cascades to the
// group's messages, Summaries, Tasks, file records, Members and insights; usage, push counts
// and webhook event IDs stay (see the initial schema). It makes no Drive call: files stay
// in the Owner's Drive. No new column: like the Drive access check, the slot is told from
// the clock, and a day whose slot tick is lost purges the next day.

/** The Bangkok time of the one tick a day that purges: night, off every default slot. */
export const PURGE_TIME = '03:00'

const SLOT_MINUTES = 15

/** Groups one run lists; the rest wait for the next day. */
export const PURGE_BATCH = 200

export function isPurgeSlot(now: Date): boolean {
  const p = bangkokParts(now)
  const sinceSlot = p.hh * 60 + p.mm - parseTimeOfDay(PURGE_TIME)
  return sinceSlot >= 0 && sinceSlot < SLOT_MINUTES
}

/** Tick job. Timed from the tick's start like the Drive finisher (driveDeadline): each
 *  delete starts only while there is still time for it. A failed delete is logged and the
 *  next group goes on; the failed one is due again tomorrow. Logs counts only. */
export const purgeJob: TickJob = {
  name: 'purge',
  async run(deps, now) {
    if (!isPurgeSlot(now)) return
    const deadline = driveDeadline(now)
    const groupIds = await deps.store.listPurgeDueGroups(now, PURGE_BATCH)
    let purged = 0
    let failed = 0
    let complete = true
    for (const groupId of groupIds) {
      try {
        checkTime(deps, deadline, 0)
        const res = await deps.store.purgeGroup(groupId, now)
        if (res.purged) purged++
      } catch (err) {
        if (err instanceof DriveTimeUp) {
          complete = false
          break
        }
        failed++
        logError('purge_failed', { groupId }, err)
      }
    }
    log('purge_done', { due: groupIds.length, purged, failed, complete })
  },
}
