// When a tick may post a lost card again (#31 take-over card, #30 owner_needed card).
//
// A card that was not sent leaves no push_log row: a push skipped near the quota, or one
// LINE refused (a 4xx releases the budget claim). The tick cannot tell those apart later,
// and a refused push is refused again, so a card is tried again only a few times, spaced
// out, counted from the ask: on the one tick that falls 15 minutes, 2 hours and 24 hours
// after it. Then no more tries. A push whose outcome is unknown (a 5xx, a timeout) keeps
// its push_log row and counts as sent, so it is never tried again.

const MIN = 60_000

/** The tick's period: each window below matches exactly one tick. */
const TICK_MS = 15 * MIN

/** How long after the ask each extra try comes: three tries in all. */
export const CARD_RETRY_AFTER_MS = [15 * MIN, 2 * 60 * MIN, 24 * 60 * MIN] as const

/** True on the one tick of each retry window after `askedAt`. */
export function isCardRetryTick(askedAt: Date, now: Date): boolean {
  const since = now.getTime() - askedAt.getTime()
  return CARD_RETRY_AFTER_MS.some((w) => since >= w && since < w + TICK_MS)
}
