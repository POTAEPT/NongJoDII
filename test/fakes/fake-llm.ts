import type { LlmPort, LlmRequest, LlmResult } from '@/server/ports'

type Queued = { kind: 'result'; value: LlmResult | ((req: LlmRequest) => LlmResult | Promise<LlmResult>) } | { kind: 'error'; err: unknown }

export class FakeLlm implements LlmPort {
  requests: LlmRequest[] = []
  private queue: Queued[] = []

  /** Queues the answer for the next call: a fixed result or a function of the request. */
  respond(value: LlmResult | ((req: LlmRequest) => LlmResult | Promise<LlmResult>)): void {
    this.queue.push({ kind: 'result', value })
  }

  /** Queues a rejection for the next call. */
  fail(err: unknown): void {
    this.queue.push({ kind: 'error', err })
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeLlm: no response queued')
    if (next.kind === 'error') throw next.err
    return typeof next.value === 'function' ? next.value(req) : next.value
  }
}
