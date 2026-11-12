import { describe, expect, it } from 'vitest'
import { OpenRouterClient } from '@/server/llm/openrouter'
import { AdapterError } from '@/server/log'

type Call = { url: string; init: RequestInit }

const REQ = { model: 'openai/gpt-oss-20b', system: 'sys', user: 'usr', maxTokens: 900 }

function stubFetch(status: number, body: unknown = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { client: new OpenRouterClient({ apiKey: 'sk-test', fetchImpl }), calls }
}

describe('OpenRouterClient.complete', () => {
  it('posts the chat completion request', async () => {
    const { client, calls } = stubFetch(200, { choices: [{ message: { content: '{}' } }] })
    await client.complete(REQ)
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(calls[0].init.method).toBe('POST')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'openai/gpt-oss-20b',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      max_tokens: 900,
      response_format: { type: 'json_object' },
    })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('parses content, model and usage', async () => {
    const { client } = stubFetch(200, {
      model: 'openai/gpt-oss-20b',
      choices: [{ message: { content: '{"a":1}' } }],
      usage: { prompt_tokens: 1521, completion_tokens: 1424, total_tokens: 2945, cost: 0.000316 },
    })
    expect(await client.complete(REQ)).toEqual({
      content: '{"a":1}',
      model: 'openai/gpt-oss-20b',
      usage: { inputTokens: 1521, outputTokens: 1424, costUsd: 0.000316 },
    })
  })

  it('returns usage null when the response has none, and costUsd null when cost is absent', async () => {
    const a = await stubFetch(200, { choices: [{ message: { content: 'x' } }] }).client.complete(REQ)
    expect(a.usage).toBeNull()
    expect(a.model).toBe(REQ.model)
    const b = await stubFetch(200, {
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    }).client.complete(REQ)
    expect(b.content).toBe('')
    expect(b.usage).toEqual({ inputTokens: 1, outputTokens: 2, costUsd: null })
  })

  it('treats usage with missing or non-finite token counts as no usage', async () => {
    for (const usage of [{ cost: 0.1 }, { prompt_tokens: 5 }, { prompt_tokens: 'x', completion_tokens: 2 }, { prompt_tokens: null, completion_tokens: 2 }]) {
      const r = await stubFetch(200, { choices: [{ message: { content: 'x' } }], usage }).client.complete(REQ)
      expect(r.usage).toBeNull()
    }
  })

  it('throws AdapterError with the status on a non-2xx answer', async () => {
    const { client } = stubFetch(429, { error: { message: 'secret chat text' } })
    const err = await client.complete(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.message).toBe('openrouter 429')
  })

  it('throws AdapterError("openrouter timeout") when the timeout aborts the request', async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal
        signal.addEventListener('abort', () => reject(signal.reason))
      })) as unknown as typeof fetch
    const client = new OpenRouterClient({ apiKey: 'k', fetchImpl, timeoutMs: 10 })
    const err = await client.complete(REQ).catch((e) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect(err.message).toBe('openrouter timeout')
  })
})
