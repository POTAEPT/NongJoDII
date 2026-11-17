import type { DecisionsPort, DecisionsRequest, DecisionsResult } from '@/server/ports'

type Answerer = DecisionsResult | ((req: DecisionsRequest) => DecisionsResult | Promise<DecisionsResult>)
type Queued = { kind: 'result'; value: Answerer } | { kind: 'error'; err: unknown }

/** The Decisions API (progress decision model) in tests: answers are queued per call. */
export class FakeDecisions implements DecisionsPort {
  requests: DecisionsRequest[] = []
  private queue: Queued[] = []

  /** Queues the answer for the next call: a fixed result or a function of the request. */
  respond(value: Answerer): void {
    this.queue.push({ kind: 'result', value })
  }

  /** Queues a rejection for the next call. */
  fail(err: unknown): void {
    this.queue.push({ kind: 'error', err })
  }

  async decide(req: DecisionsRequest): Promise<DecisionsResult> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeDecisions: no response queued')
    if (next.kind === 'error') throw next.err
    return typeof next.value === 'function' ? next.value(req) : next.value
  }
}
