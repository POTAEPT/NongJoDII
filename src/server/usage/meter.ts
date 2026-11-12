import { log } from '../log'
import type { AiPurpose, Deps, LlmRequest, LlmResult } from '../ports'
import { priceTokens, roundUpUsd } from './pricing'

export type MeterContext = { ownerLineUserId: string; projectId: string | null; groupId: string; purpose: AiPurpose }

/** Every AI call goes through here: calls the model, then records the response's
 *  token counts against the Owner (rules: "Every AI call records the token counts"). */
export async function runMeteredAi(deps: Deps, ctx: MeterContext, req: LlmRequest): Promise<LlmResult> {
  // A throw propagates and nothing is recorded: there is no response, so there is nothing to count.
  const result = await deps.llm.complete(req)

  let inputTokens: number
  let outputTokens: number
  let costUsd: number
  if (result.usage) {
    inputTokens = result.usage.inputTokens
    outputTokens = result.usage.outputTokens
    const reported = result.usage.costUsd
    costUsd = roundUpUsd(
      reported !== null && Number.isFinite(reported) && reported >= 0 ? reported : priceTokens(inputTokens, outputTokens),
    )
  } else {
    // Contract break: record a conservative estimate rather than nothing.
    inputTokens = Math.ceil((req.system.length + req.user.length) / 2)
    outputTokens = req.maxTokens
    costUsd = priceTokens(inputTokens, outputTokens)
    log('ai_usage_missing', { groupId: ctx.groupId })
  }

  await deps.store.insertAiUsage({
    ...ctx,
    model: result.model,
    inputTokens,
    outputTokens,
    costUsd,
    createdAt: deps.now(),
  })
  return result
}
