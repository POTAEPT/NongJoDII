import { AdapterError } from '../log'
import type { LlmPort, LlmRequest, LlmResult } from '../ports'

const URL = 'https://openrouter.ai/api/v1/chat/completions'

type ChatCompletion = {
  model?: string
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown }
}

/** OpenRouter chat completions. Errors carry the HTTP status only, never the response body. */
export class OpenRouterClient implements LlmPort {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.apiKey = opts.apiKey
    // Resolve the global at call time, so a fetch replaced after construction is used.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    // 45 s keeps the call inside the webhook route's maxDuration (60) and the reply token's lifetime.
    this.timeoutMs = opts.timeoutMs ?? 45_000
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    let res: Response
    try {
      res = await this.fetchImpl(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, req.timeoutMs ?? this.timeoutMs)),
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new AdapterError('openrouter timeout')
      throw err
    }
    if (!res.ok) throw new AdapterError(`openrouter ${res.status}`)
    const json = (await res.json()) as ChatCompletion
    const usage = json.usage
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      model: json.model ?? req.model,
      // Missing or non-finite token counts mean no usable usage: the caller falls back to its conservative estimate.
      usage: usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)
        ? {
            inputTokens: usage.prompt_tokens as number,
            outputTokens: usage.completion_tokens as number,
            costUsd: typeof usage.cost === 'number' ? usage.cost : null,
          }
        : null,
    }
  }
}
