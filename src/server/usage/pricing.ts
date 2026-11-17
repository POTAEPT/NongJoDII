export const TEXT_MODEL = 'openai/gpt-oss-20b'
export const PRICE_INPUT_USD_PER_TOKEN = 0.04488 / 1_000_000 // wiki LLM Cost Estimate, user 2026-11-05
export const PRICE_OUTPUT_USD_PER_TOKEN = 0.174 / 1_000_000

/** The decision model tags progress lines (#7): TypeSafe Jev through OpenRouter's Decisions
 *  API (src/server/llm/openrouter-decisions.ts), not a chat model (user decision 2026-11-17). */
export const DECISION_MODEL = 'typesafe/jev-1.14'
export const DECISION_PRICE_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000 // openrouter.ai model page, read 2026-11-17
export const DECISION_PRICE_OUTPUT_USD_PER_TOKEN = 0

type ModelPrice = { input: number; output: number }
const PRICES: Record<string, ModelPrice> = {
  [TEXT_MODEL]: { input: PRICE_INPUT_USD_PER_TOKEN, output: PRICE_OUTPUT_USD_PER_TOKEN },
  [DECISION_MODEL]: { input: DECISION_PRICE_INPUT_USD_PER_TOKEN, output: DECISION_PRICE_OUTPUT_USD_PER_TOKEN },
}

/** A model's prices. Any other slug gets the text model's, the dearer of the two, so an
 *  unknown model is never priced low. */
export function modelPrice(model: string): ModelPrice {
  return PRICES[model] ?? PRICES[TEXT_MODEL]
}

export function roundUpUsd(x: number): number {
  return Math.ceil(x * 1e6 - 1e-9) / 1e6
}

/** Price by the model the caller asked for (not the slug the provider echoes back). */
export function priceTokens(model: string, inputTokens: number, outputTokens: number): number {
  const p = modelPrice(model)
  return roundUpUsd(inputTokens * p.input + outputTokens * p.output)
}
