import { log, logError } from '../log'
import type {
  AiPurpose, AiUsageActual, DecisionsRequest, DecisionsResult, Deps, LlmRequest, LlmResult, LlmUsage,
} from '../ports'
import { FAIR_USE_CAP_TOKENS, FAIR_USE_CAP_USD } from './fair-use'
import { priceTokens, roundUpUsd } from './pricing'

export type MeterContext = { ownerLineUserId: string; projectId: string | null; groupId: string; purpose: AiPurpose }

/** The Owner reached the Fair-use cap when the call tried to claim its usage: no model call was made. */
export class FairUseCapReachedError extends Error {
  name = 'FairUseCapReachedError'
}

const SETTLE_ATTEMPTS = 3

/** Every AI call goes through here and records the response's token counts against
 *  the Owner (rules: "Every AI call records the token counts").
 *
 *  1. Claim: a usage row holding a conservative estimate is stored before the call,
 *     serialized per Owner in the store, so concurrent requests cannot all pass the
 *     cap check and spend past it. A refused claim throws FairUseCapReachedError.
 *  2. Call the model. On a throw the claim is released (there is no response, so
 *     nothing to charge); a failed release leaves the estimate, which over-counts.
 *  3. Settle the claim with the real numbers, retried because settle is an UPDATE by
 *     id and cannot save the charge twice. If every attempt fails, the estimate row
 *     stays: the Owner's usage is over-counted, never under-counted. */
export async function runMeteredAi(deps: Deps, ctx: MeterContext, req: LlmRequest): Promise<LlmResult> {
  return runMetered(deps, ctx, estimateUsage(req), req.model, () => deps.llm.complete(req))
}

/** The same claim, call and settle for a Decisions API call (the progress decision model). */
export async function runMeteredDecisions(deps: Deps, ctx: MeterContext, req: DecisionsRequest): Promise<DecisionsResult> {
  return runMetered(deps, ctx, estimateDecisionsUsage(req), req.model, () => deps.decisions.decide(req))
}

async function runMetered<R extends { model: string; usage: LlmUsage | null }>(
  deps: Deps, ctx: MeterContext, estimate: AiUsageActual, pricedModel: string, call: () => Promise<R>,
): Promise<R> {
  const { claimId } = await deps.store.claimAiUsage(
    { ...ctx, ...estimate, createdAt: deps.now() },
    { capTokens: FAIR_USE_CAP_TOKENS, capCostUsd: FAIR_USE_CAP_USD },
  )
  if (claimId === null) throw new FairUseCapReachedError('fair-use cap reached')

  let result: R
  try {
    result = await call()
  } catch (err) {
    try {
      await deps.store.releaseAiUsage(claimId)
    } catch (releaseErr) {
      logError('ai_usage_release_failed', { groupId: ctx.groupId }, releaseErr)
    }
    throw err
  }

  let actual: AiUsageActual
  if (result.usage) {
    const { inputTokens, outputTokens, costUsd: reported } = result.usage
    const costUsd = roundUpUsd(
      reported !== null && Number.isFinite(reported) && reported >= 0
        ? reported
        : priceTokens(pricedModel, inputTokens, outputTokens),
    )
    actual = { model: result.model, inputTokens, outputTokens, costUsd }
  } else {
    // Contract break: keep the conservative estimate rather than nothing.
    actual = { ...estimate, model: result.model }
    log('ai_usage_missing', { groupId: ctx.groupId })
  }

  // No sleep between attempts: the route has a 60 s budget and the model call used most of it.
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    try {
      await deps.store.settleAiUsage(claimId, actual)
      break
    } catch (err) {
      logError('ai_usage_settle_failed', { groupId: ctx.groupId, attempt }, err)
    }
  }
  return result
}

function estimateUsage(req: LlmRequest): AiUsageActual {
  const inputTokens = Math.ceil((req.system.length + req.user.length) / 2)
  const outputTokens = req.maxTokens
  return { model: req.model, inputTokens, outputTokens, costUsd: priceTokens(req.model, inputTokens, outputTokens) }
}

/** Decision models answer with probabilities, not text. A live Jev call with three questions
 *  reported 87 output tokens (billed at $0), so the estimate allows this many. */
const DECISIONS_OUTPUT_ESTIMATE = 256

/** The input is the state and every question, as sent. */
function estimateDecisionsUsage(req: DecisionsRequest): AiUsageActual {
  const inputTokens = Math.ceil((req.state.length + JSON.stringify(req.questions).length) / 2)
  const outputTokens = DECISIONS_OUTPUT_ESTIMATE
  return { model: req.model, inputTokens, outputTokens, costUsd: priceTokens(req.model, inputTokens, outputTokens) }
}
