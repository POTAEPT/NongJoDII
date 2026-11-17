import { AdapterError } from '../log'
import type { DecisionAnswer, DecisionQuestion, DecisionsPort, DecisionsRequest, DecisionsResult } from '../ports'

const URL = 'https://openrouter.ai/api/alpha/decisions'

type RawResponse = {
  model?: unknown
  answers?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cost?: unknown }
}

/** OpenRouter Decisions API (`POST /api/alpha/decisions`): typed answers from a decision model
 *  such as TypeSafe Jev, which does not serve chat completions. Errors carry the HTTP status
 *  only, never the response body. */
export class OpenRouterDecisionsClient implements DecisionsPort {
  private readonly apiKey: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.apiKey = opts.apiKey
    // Resolve the global at call time, so a fetch replaced after construction is used.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    // Same ceiling as the chat client: inside the webhook route's maxDuration (60).
    this.timeoutMs = opts.timeoutMs ?? 45_000
  }

  async decide(req: DecisionsRequest): Promise<DecisionsResult> {
    let res: Response
    try {
      res = await this.fetchImpl(URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          state: req.state,
          questions: req.questions,
          ...(req.user ? { user: req.user } : {}),
          ...(req.sessionId ? { session_id: req.sessionId } : {}),
        }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, req.timeoutMs ?? this.timeoutMs)),
      })
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') throw new AdapterError('openrouter decisions timeout')
      throw err
    }
    if (!res.ok) throw new AdapterError(`openrouter decisions ${res.status}`)
    const json = (await res.json()) as RawResponse
    const raw = json.answers && typeof json.answers === 'object' ? (json.answers as Record<string, unknown>) : {}
    const answers: Record<string, DecisionAnswer | null> = {}
    for (const [key, question] of Object.entries(req.questions)) answers[key] = parseAnswer(raw[key], question)
    const usage = json.usage
    return {
      model: typeof json.model === 'string' ? json.model : req.model,
      answers,
      // Missing or non-finite token counts mean no usable usage: the caller falls back to its estimate.
      usage: usage && isFiniteNumber(usage.input_tokens) && isFiniteNumber(usage.output_tokens)
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            costUsd: isFiniteNumber(usage.cost) ? usage.cost : null,
          }
        : null,
    }
  }
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function probabilitiesOf(x: unknown): Record<string, number> | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!isFiniteNumber(v)) return null
    out[k] = v
  }
  return out
}

/** The answer when it matches the question asked; null for a refusal, a missing answer or any
 *  other shape (the docs: never read those as a negative verdict). */
export function parseAnswer(raw: unknown, question: DecisionQuestion): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (a.type !== question.type) return null
  const confidence = isFiniteNumber(a.confidence) ? a.confidence : null
  if (question.type === 'noul') {
    if (!isFiniteNumber(a.noul) || a.noul < 0 || a.noul > 1) return null
    return { type: 'noul', noul: a.noul, confidence }
  }
  const probabilities = a.probabilities === undefined ? {} : probabilitiesOf(a.probabilities)
  if (!probabilities) return null
  if (question.type === 'choice') {
    // Only a key that was offered: anything else cannot be mapped back.
    if (typeof a.choice !== 'string' || !Object.hasOwn(question.criteria, a.choice)) return null
    return { type: 'choice', choice: a.choice, probabilities, confidence }
  }
  if (!isFiniteNumber(a.score)) return null
  return { type: 'score', score: a.score, probabilities, confidence }
}
