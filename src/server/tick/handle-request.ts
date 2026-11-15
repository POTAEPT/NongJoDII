import { createHash, timingSafeEqual } from 'node:crypto'
import type { Defer, Deps } from '@/server/ports'
import { TICK_JOBS, runTick, type TickJob } from './run-tick'

/** Constant-time comparison of the x-tick-secret header with the configured secret
 *  (rules: Baseline). Both sides are hashed first so their lengths always match. */
function tickSecretMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false
  const a = createHash('sha256').update(given, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/** The scheduler tick: Supabase pg_cron calls this every 15 minutes through pg_net
 *  (supabase/migrations/20261113085308_scheduler_ticks.sql). Like the webhook, it
 *  answers at once and does the work after the response; pg_net does not wait for it.
 *  The body is ignored: the jobs decide what is due from the clock and the database. */
export async function handleTickRequest(
  request: Request,
  deps: Deps,
  defer: Defer,
  jobs: TickJob[] = TICK_JOBS,
): Promise<Response> {
  if (!tickSecretMatches(request.headers.get('x-tick-secret'), deps.config.tickSecret)) {
    return new Response('unauthorized', { status: 401 })
  }
  defer(() => runTick(deps, jobs))
  return new Response('ok', { status: 200 })
}
