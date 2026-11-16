import { describe, expect, it } from 'vitest'
import { FairUseCapReachedError, runMeteredAi, runMeteredDecisions } from '@/server/usage/meter'
import { DECISION_MODEL, priceTokens, TEXT_MODEL } from '@/server/usage/pricing'
import { makeTestDeps, TEST_NOW } from './harness'

const REQ = { model: 'openai/gpt-oss-20b', system: 'abcd', user: 'efghij', maxTokens: 700 }

async function setup() {
  const t = makeTestDeps()
  await t.store.upsertLineUser({ lineUserId: 'Uowner1', displayName: 'Owner' })
  const group = await t.store.ensureGroup('Cg1')
  const ctx = { ownerLineUserId: 'Uowner1', projectId: null, groupId: group.id, purpose: 'summary' as const }
  return { ...t, ctx, groupId: group.id }
}

describe('runMeteredAi', () => {
  it('records the reported token counts and the computed cost against the Owner', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'openai/gpt-oss-20b', usage: { inputTokens: 1000, outputTokens: 500, costUsd: null } })
    const result = await runMeteredAi(t.deps, t.ctx, REQ)
    expect(result.content).toBe('{}')
    const rows = t.store.tables.ai_usage
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      ownerLineUserId: 'Uowner1', groupId: t.groupId, projectId: null, purpose: 'summary',
      model: 'openai/gpt-oss-20b', inputTokens: 1000, outputTokens: 500,
    })
    expect(rows[0].costUsd).toBe(priceTokens(TEXT_MODEL, 1000, 500))
    expect(rows[0].costUsd).toBe(0.000132)
    expect(rows[0].createdAt).toEqual(TEST_NOW)
  })

  it('uses the cost reported by the provider when it is valid', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'm', usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.0004 } })
    await runMeteredAi(t.deps, t.ctx, REQ)
    expect(t.store.tables.ai_usage[0].costUsd).toBe(0.0004)
  })

  it('falls back to the price table when the reported cost is negative or not finite', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'm', usage: { inputTokens: 1000, outputTokens: 500, costUsd: -1 } })
    t.llm.respond({ content: '{}', model: 'm', usage: { inputTokens: 1000, outputTokens: 500, costUsd: Number.NaN } })
    await runMeteredAi(t.deps, t.ctx, REQ)
    await runMeteredAi(t.deps, t.ctx, REQ)
    expect(t.store.tables.ai_usage.map((r) => r.costUsd)).toEqual([0.000132, 0.000132])
  })

  it('records a conservative estimate when the response has no usage', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'm', usage: null })
    await runMeteredAi(t.deps, t.ctx, REQ)
    const row = t.store.tables.ai_usage[0]
    expect(row.outputTokens).toBe(REQ.maxTokens)
    expect(row.inputTokens).toBe(5)
    expect(row.costUsd).toBe(priceTokens(TEXT_MODEL, 5, 700))
  })

  it('propagates an LLM error and records nothing', async () => {
    const t = await setup()
    t.llm.fail(new Error('boom'))
    await expect(runMeteredAi(t.deps, t.ctx, REQ)).rejects.toThrow('boom')
    expect(t.store.tables.ai_usage).toHaveLength(0)
  })

  it('keeps the estimate when the claim cannot be released after an LLM error (over-counts, never under-counts)', async () => {
    const t = await setup()
    t.llm.fail(new Error('boom'))
    t.store.failNext('releaseAiUsage')
    await expect(runMeteredAi(t.deps, t.ctx, REQ)).rejects.toThrow('boom')
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({ inputTokens: 5, outputTokens: REQ.maxTokens, settledAt: null })
  })

  it('refuses at the Fair-use cap without calling the model or recording usage', async () => {
    const t = await setup()
    t.store.seedAiUsage({ costUsd: 0.5, createdAt: TEST_NOW })
    await expect(runMeteredAi(t.deps, t.ctx, REQ)).rejects.toBeInstanceOf(FairUseCapReachedError)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(1)
  })

  it('a usage write that fails once after a successful response is retried into one row with the real numbers', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'openai/gpt-oss-20b', usage: { inputTokens: 1000, outputTokens: 500, costUsd: null } })
    t.store.failNext('settleAiUsage')
    const result = await runMeteredAi(t.deps, t.ctx, REQ)
    expect(result.content).toBe('{}')
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({ inputTokens: 1000, outputTokens: 500, costUsd: 0.000132 })
    expect(t.store.tables.ai_usage[0].settledAt).not.toBeNull()
  })

  it('when the usage write keeps failing, the estimate stays recorded and the result is still returned', async () => {
    const t = await setup()
    t.llm.respond({ content: '{}', model: 'openai/gpt-oss-20b', usage: { inputTokens: 1000, outputTokens: 500, costUsd: null } })
    for (let i = 0; i < 5; i++) t.store.failNext('settleAiUsage')
    const result = await runMeteredAi(t.deps, t.ctx, REQ)
    expect(result.content).toBe('{}')
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({
      inputTokens: 5, outputTokens: REQ.maxTokens, costUsd: priceTokens(TEXT_MODEL, 5, 700), settledAt: null,
    })
  })
})

describe('priceTokens', () => {
  it('rounds the cost up to a micro-dollar', () => {
    expect(priceTokens(TEXT_MODEL, 2578, 1424)).toBe(0.000364)
  })

  it('prices each model at its own rate; Jev bills input only, an unknown slug gets the text price', () => {
    expect(priceTokens(DECISION_MODEL, 1_000_000, 500)).toBe(0.042)
    expect(priceTokens(TEXT_MODEL, 1_000_000, 0)).toBe(0.04488)
    expect(priceTokens('other/model', 1_000_000, 0)).toBe(0.04488)
  })
})

describe('runMeteredDecisions', () => {
  const DREQ = { model: DECISION_MODEL, state: 'x'.repeat(100), questions: { q: { type: 'noul' as const, instructions: 'y' } } }

  it('claims, calls the Decisions port and settles with the reported cost', async () => {
    const t = await setup()
    t.decisions.respond({ model: DECISION_MODEL, answers: { q: null }, usage: { inputTokens: 400, outputTokens: 0, costUsd: 0.0000168 } })
    await runMeteredDecisions(t.deps, t.ctx, DREQ)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(1)
    // roundUpUsd keeps whole micro-dollars.
    expect(t.store.tables.ai_usage[0]).toMatchObject({ model: DECISION_MODEL, inputTokens: 400, outputTokens: 0, costUsd: 0.000017 })
    expect(t.store.tables.ai_usage[0].settledAt).not.toBeNull()
  })

  it('without a reported cost, prices by the slug asked for, not the dated slug OpenRouter echoes', async () => {
    const t = await setup()
    t.decisions.respond({ model: 'typesafe/jev-1.14-20261014', answers: {}, usage: { inputTokens: 1_000_000, outputTokens: 87, costUsd: null } })
    await runMeteredDecisions(t.deps, t.ctx, DREQ)
    expect(t.store.tables.ai_usage[0]).toMatchObject({ model: 'typesafe/jev-1.14-20261014', costUsd: 0.042 })
  })

  it('releases the claim when the port throws', async () => {
    const t = await setup()
    t.decisions.fail(new Error('openrouter decisions 500'))
    await expect(runMeteredDecisions(t.deps, t.ctx, DREQ)).rejects.toThrow('500')
    expect(t.store.tables.ai_usage).toHaveLength(0)
  })
})
