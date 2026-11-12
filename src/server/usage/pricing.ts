export const TEXT_MODEL = 'openai/gpt-oss-20b'
/** The decision model tags progress lines (#7); TEXT_MODEL is its fallback. Same model until
 *  the team picks a cheaper one: PRICE_* below would then need that model's prices. */
export const DECISION_MODEL = 'openai/gpt-oss-20b'
export const PRICE_INPUT_USD_PER_TOKEN = 0.04488 / 1_000_000 // wiki LLM Cost Estimate, user 2026-11-05
export const PRICE_OUTPUT_USD_PER_TOKEN = 0.174 / 1_000_000

export function roundUpUsd(x: number): number {
  return Math.ceil(x * 1e6 - 1e-9) / 1e6
}

export function priceTokens(inputTokens: number, outputTokens: number): number {
  return roundUpUsd(inputTokens * PRICE_INPUT_USD_PER_TOKEN + outputTokens * PRICE_OUTPUT_USD_PER_TOKEN)
}
