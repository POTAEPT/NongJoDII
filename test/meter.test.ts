import { describe, expect, it } from 'vitest'
import { runMeteredAi } from '@/server/usage/meter'
import { priceTokens } from '@/server/usage/pricing'
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
    expect(rows[0].costUsd).toBe(priceTokens(1000, 500))
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
    expect(row.costUsd).toBe(priceTokens(5, 700))
  })

  it('propagates an LLM error and records nothing', async () => {
    const t = await setup()
    t.llm.fail(new Error('boom'))
    await expect(runMeteredAi(t.deps, t.ctx, REQ)).rejects.toThrow('boom')
    expect(t.store.tables.ai_usage).toHaveLength(0)
  })
})

describe('priceTokens', () => {
  it('rounds the cost up to a micro-dollar', () => {
    expect(priceTokens(2578, 1424)).toBe(0.000364)
  })
})
