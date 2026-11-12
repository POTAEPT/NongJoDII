import { verifyLineSignature } from '@/server/line/signature'
import type { LineEvent } from '@/server/line/types'
import { logError } from '@/server/log'
import type { Defer, Deps } from '@/server/ports'
import { ingestEvents } from './ingest'
import { processJobs } from './process'

export async function handleWebhookRequest(request: Request, deps: Deps, defer: Defer): Promise<Response> {
  const raw = await request.text()
  const signature = request.headers.get('x-line-signature')
  if (!verifyLineSignature(raw, signature, deps.config.lineChannelSecret)) {
    return new Response('invalid signature', { status: 401 })
  }

  let events: LineEvent[]
  try {
    const body: unknown = JSON.parse(raw)
    const candidate = (body as { events?: unknown } | null)?.events
    if (!Array.isArray(candidate)) return new Response('bad request', { status: 400 })
    events = candidate as LineEvent[]
  } catch {
    return new Response('bad request', { status: 400 })
  }

  const { jobs, error } = await ingestEvents(deps, events)
  // Even when ingest failed midway: events before the failing one already have their
  // messages rows, so a redelivery reports them as duplicates and would lose their jobs.
  if (jobs.length) defer(() => processJobs(deps, jobs))
  if (error) {
    logError('webhook_ingest_failed', {}, error)
    return new Response('ingest failed', { status: 500 })
  }
  return new Response('ok', { status: 200 })
}
