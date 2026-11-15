import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { isCardRetryTick } from '../line/card-retry'
import { log, logError } from '../log'
import type { TickJob } from '../tick/run-tick'
import { TAKEOVER_WAIT_MS } from './detach'
import { askTakeoverQuestion } from './start'

// #31 review (#72): the take-over card is pushed once, after the Owner change's response.
// A push skipped near the quota, or one LINE refused (a 4xx), left no push_log row, and
// nothing asked again: the Sub groups would wait unasked until the 7-day rule detached them.
// This job posts the card again for a Project whose Sub groups still wait (not expired) and
// whose main group has no owner_takeover push since the ask, but only on the few retry
// ticks of line/card-retry.ts (15 min, 2 h and 24 h after the ask), so a card LINE keeps
// refusing is tried three more times, not every tick for 7 days. The retry key is the
// question's (askTakeoverQuestion), so LINE drops a repeat inside 24 h.

/** LINE steps of one card, as checkTime counts them: member count and quota, then the push. */
const TAKEOVER_CARD_CALLS = 2

export const takeoverCardRetryJob: TickJob = {
  name: 'subgroup_takeover_card_retry',
  async run(deps, now) {
    const unsent = await deps.store.listUnsentTakeoverCards(new Date(now.getTime() - TAKEOVER_WAIT_MS))
    const due = unsent.filter((u) => isCardRetryTick(u.askedAt, now))
    const deadline = driveDeadline(now)
    for (const [i, { projectId }] of due.entries()) {
      try {
        checkTime(deps, deadline, TAKEOVER_CARD_CALLS)
      } catch (err) {
        if (!(err instanceof DriveTimeUp)) throw err
        log('owner_takeover_card_retry_incomplete', { projectsLeft: due.length - i })
        return
      }
      try {
        const { card } = await askTakeoverQuestion(deps, { projectId })
        log('owner_takeover_card_retry', { projectId, card })
      } catch (err) {
        logError('owner_takeover_card_retry_failed', { projectId }, err)
      }
    }
  },
}
