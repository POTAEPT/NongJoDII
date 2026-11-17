import { describe, expect, it } from 'vitest'
import { OpenRouterDecisionsClient } from '@/server/llm/openrouter-decisions'
import { AdapterError } from '@/server/log'
import type { DecisionsRequest } from '@/server/ports'
import { buildDecisionsRequest } from '@/server/progress/decide'
import { DECISION_MODEL } from '@/server/usage/pricing'

// The Decisions API adapter (TypeSafe Jev) against a fake fetch: request shape, answer parsing,
// and errors that carry the status only.

type Call = { url: string; init: RequestInit }

const REQ: DecisionsRequest = {
  model: DECISION_MODEL,
  state: 'Chat line:\nเสร็จแล้ว',
  questions: {
    is_progress: { type: 'noul', instructions: 'Is it progress?' },
    status: { type: 'choice', instructions: 'Which status?', criteria: { done: 'finished', in_process: 'started' } },
    level: { type: 'score', instructions: 'How sure?', criteria: ['low', 'high'] },
  },
}

function stubFetch(status: number, body: unknown = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { client: new OpenRouterDecisionsClient({ apiKey: 'sk-test', fetchImpl }), calls }
}

const hang = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal
    signal.addEventListener('abort', () => reject(signal.reason))
  })) as unknown as typeof fetch

describe('OpenRouterDecisionsClient.decide', () => {
  it('posts model, state and questions to the Decisions endpoint', async () => {
    const { client, calls } = stubFetch(200, { answers: {} })
    await client.decide({ ...REQ, user: 'Uowner1', sessionId: 'g1', timeoutMs: 5_000 })
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'typesafe/jev-1.14', state: REQ.state, questions: REQ.questions, user: 'Uowner1', session_id: 'g1',
    })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('sends the progress request with the Jev slug and the three typed questions', async () => {
    const { client, calls } = stubFetch(200, { answers: {} })
    const req = buildDecisionsRequest({
      text: 'เสร็จแล้ว', senderLineUserId: 'U1', members: [], workDescription: null,
      tasks: [{ id: 'a', title: 'สไลด์', status: 'in_process', assigneeLineUserId: null }] as never,
    })
    await client.decide(req)
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.model).toBe('typesafe/jev-1.14')
    expect(body.timeoutMs).toBeUndefined()
    expect(Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, (q as { type: string }).type])))
      .toEqual({ is_progress: 'noul', status: 'choice', task: 'choice' })
    expect(Object.keys(body.questions.task.criteria)).toEqual(['t1', 'none'])
  })

  it('parses noul, choice and score answers, the model and usage.cost', async () => {
    const { client } = stubFetch(200, {
      id: 'gen-dec-1', model: 'typesafe/jev-1.14', provider: 'TypeSafe',
      answers: {
        is_progress: { type: 'noul', noul: 0.93, confidence: 0.93 },
        status: { type: 'choice', choice: 'done', probabilities: { done: 0.97, in_process: 0.03 }, confidence: 0.97 },
        level: { type: 'score', score: 0.8, probabilities: { 0: 0.2, 1: 0.8 }, confidence: 0.8 },
      },
      usage: { input_tokens: 412, output_tokens: 0, cost: 0.0000173, input_tokens_details: { cached_tokens: 0 } },
    })
    expect(await client.decide(REQ)).toEqual({
      model: 'typesafe/jev-1.14',
      answers: {
        is_progress: { type: 'noul', noul: 0.93, confidence: 0.93 },
        status: { type: 'choice', choice: 'done', probabilities: { done: 0.97, in_process: 0.03 }, confidence: 0.97 },
        level: { type: 'score', score: 0.8, probabilities: { 0: 0.2, 1: 0.8 }, confidence: 0.8 },
      },
      usage: { inputTokens: 412, outputTokens: 0, costUsd: 0.0000173 },
    })
  })

  it('a refusal, a missing answer, a wrong type or an unknown choice comes back as null', async () => {
    const { client } = stubFetch(200, {
      answers: {
        is_progress: { type: 'refusal' },
        status: { type: 'choice', choice: 'maybe', probabilities: { maybe: 1 }, confidence: 1 },
        level: { type: 'noul', noul: 0.5 },
      },
    })
    const res = await client.decide(REQ)
    expect(res.answers).toEqual({ is_progress: null, status: null, level: null })

    const missing = await stubFetch(200, { answers: { status: { type: 'choice', choice: 'done' } } }).client.decide(REQ)
    expect(missing.answers.is_progress).toBeNull()
    // Confidence and probabilities are optional in the docs' type.
    expect(missing.answers.status).toEqual({ type: 'choice', choice: 'done', probabilities: {}, confidence: null })
  })

  it('a noul outside 0..1 is not an answer', async () => {
    const res = await stubFetch(200, { answers: { is_progress: { type: 'noul', noul: 1.5 } } }).client.decide(REQ)
    expect(res.answers.is_progress).toBeNull()
  })

  it('returns usage null without finite token counts, and costUsd null without cost', async () => {
    const a = await stubFetch(200, { answers: {}, usage: { cost: 0.1 } }).client.decide(REQ)
    expect(a.usage).toBeNull()
    expect(a.model).toBe(DECISION_MODEL)
    const b = await stubFetch(200, { answers: {}, usage: { input_tokens: 10, output_tokens: 0 } }).client.decide(REQ)
    expect(b.usage).toEqual({ inputTokens: 10, outputTokens: 0, costUsd: null })
  })

  it('throws AdapterError with the status only on a non-2xx answer', async () => {
    const { client } = stubFetch(400, { error: { message: 'secret chat text' } })
    const err = await client.decide(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.message).toBe('openrouter decisions 400')
  })

  it('throws AdapterError("openrouter decisions timeout"), with a per-request timeout no longer than its own', async () => {
    const short = new OpenRouterDecisionsClient({ apiKey: 'k', fetchImpl: hang, timeoutMs: 60_000 })
    const err = await short.decide({ ...REQ, timeoutMs: 10 }).catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.message).toBe('openrouter decisions timeout')

    const capped = new OpenRouterDecisionsClient({ apiKey: 'k', fetchImpl: hang, timeoutMs: 10 })
    const err2 = await capped.decide({ ...REQ, timeoutMs: 60_000 }).catch((e) => e)
    expect(err2.message).toBe('openrouter decisions timeout')
  })
})
