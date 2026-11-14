import { open } from '../crypto/secretbox'
import { GoogleTokenRevoked, log, logError } from '../log'
import type { TickJob } from '../tick/run-tick'
import { BKK_OFFSET_MS, bangkokParts, parseTimeOfDay } from '../time/bangkok'
import { checkTime, driveDeadline, DriveTimeUp } from './drive-folders'
import { LOST_ACCESS_CALLS, markAccessLost } from './lost-access'

// #14: the daily Drive access check. A Drive run meets a revoked grant only while the
// folders are being set up (a sign-in, an Owner confirm, the finisher's 2-hour window), so
// an Owner who revokes access later would get no card and the LIFF would keep saying
// "connected". Once a day this job refreshes the access token of each Google account that
// holds a Project's active Drive connection. An account Google answers invalid_grant for
// goes down the same path as in a Drive run (markAccessLost): marked revoked, one card in
// the main group. No new column: the slot is told from the clock alone, and the
// conditional UPDATE in markAccessLost already makes the card once-only.

/** The Bangkok time of the one tick a day that runs the check: a quarter hour, in the
 *  daytime so the Owner sees the card, and off the default 09:00 reminder slot. */
export const ACCESS_CHECK_TIME = '10:30'

/** The tick comes every 15 minutes, so exactly one a day starts inside this window. A day
 *  whose tick in the window is lost is not caught up: the next day checks again. */
const SLOT_MINUTES = 15

export function isAccessCheckSlot(now: Date): boolean {
  const p = bangkokParts(now)
  const sinceSlot = p.hh * 60 + p.mm - parseTimeOfDay(ACCESS_CHECK_TIME)
  return sinceSlot >= 0 && sinceSlot < SLOT_MINUTES
}

/** How far the start of the list moves each day. A day of slow Google calls (10 s each)
 *  still reaches this many accounts inside the tick's time, so with this step every
 *  account is reached within ceil(n / step) days, with no stored resume point. */
export const ACCESS_CHECK_STEP = 5

/** `ids` starting at a place that moves by ACCESS_CHECK_STEP each Bangkok day, wrapping
 *  around. Without it a slow check would stop at the same place every day, and the
 *  accounts after it would never be tried. */
export function rotateForDay<T>(ids: T[], now: Date): T[] {
  if (ids.length === 0) return []
  const day = Math.floor((now.getTime() + BKK_OFFSET_MS) / 86_400_000)
  const start = (day * ACCESS_CHECK_STEP) % ids.length
  return [...ids.slice(start), ...ids.slice(0, start)]
}

/** Tick job. Timed from the tick's start like the Drive finisher, one Google call per
 *  account (plus the card's LINE calls for a revoked one), and it starts no call that
 *  could end after the hard stop. Any failure but invalid_grant (a timeout, a 5xx, a store
 *  error) skips that account until tomorrow and never marks it. Logs counts only. */
export const driveAccessCheckJob: TickJob = {
  name: 'drive_access_check',
  async run(deps, now) {
    if (!isAccessCheckSlot(now)) return
    const deadline = driveDeadline(now)
    const projectIds = rotateForDay(await deps.store.listDriveConnectedProjects(), now)
    const seen = new Set<string>() // an account that holds several Projects is tried once
    let accounts = 0
    let revoked = 0
    let skipped = 0
    let complete = true
    for (const projectId of projectIds) {
      try {
        const ctx = await deps.store.getDriveContext(projectId)
        const account = ctx?.account
        // Only the account that holds the Project, while it is the Owner's latest and
        // still valid: a revoked one was handled before, and a Project held by another
        // account than the latest waits for the Owner (the LIFF notice).
        if (!ctx || !account || account.tokenStatus !== 'valid' || account.refreshTokenCiphertext === null) continue
        if (ctx.activeAccountId !== account.id || seen.has(account.id)) continue
        seen.add(account.id)
        const refreshToken = open(account.refreshTokenCiphertext, deps.config.tokenEncryptionKey)
        if (refreshToken === null) {
          skipped++
          continue
        }
        checkTime(deps, deadline, 1)
        accounts++
        try {
          await deps.google.accessToken(refreshToken)
        } catch (err) {
          if (!(err instanceof GoogleTokenRevoked)) throw err
          // As in a Drive run: no time for the card, no mark; tomorrow meets it again.
          checkTime(deps, deadline, LOST_ACCESS_CALLS)
          await markAccessLost(deps, ctx, { id: account.id, refreshTokenCiphertext: account.refreshTokenCiphertext })
          revoked++
        }
      } catch (err) {
        if (err instanceof DriveTimeUp) {
          complete = false
          break
        }
        skipped++
        logError('drive_access_check_skipped', { projectId }, err)
      }
    }
    log('drive_access_check', { accounts, revoked, skipped, complete })
  },
}
