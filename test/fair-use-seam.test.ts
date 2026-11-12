import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineMessage } from '@/server/line/types'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_NOW, webhookBody } from './harness'

const ANSWER = JSON.stringify({ summary: 'สรุป', tasks: [] })

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function texts(ms: LineMessage[]): string[] {
  return ms.map((m) => (m.type === 'text' ? m.text : ''))
}

async function setup() {
  const h = makeTestDeps()
  const ga = seedOwnedGroup(h.store, { lineGroupId: 'Cga' })
  const gb = seedOwnedGroup(h.store, { lineGroupId: 'Cgb' })
  const send = async (group: string, text: string) => {
    const res = await handleWebhookRequest(
      signedRequest(webhookBody(ev.groupText({ text, groupId: group, userId: 'Uuser1', timestamp: h.deps.now().getTime() }))),
      h.deps, h.defer,
    )
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  await send('Cga', 'งานเยอะมาก')
  await send('Cgb', 'งานเยอะมาก')
  /** Queue an LLM answer costing `cost`, run summarize in the group; returns that reply. */
  const summarize = async (group: 'Cga' | 'Cgb', cost = 0.02) => {
    h.llm.respond({ content: ANSWER, model: TEXT_MODEL, usage: { inputTokens: 100, outputTokens: 50, costUsd: cost } })
    const before = h.line.replies.length
    await send(group, 'NongJoDII summarize')
    expect(h.line.replies.length).toBe(before + 1)
    return texts(h.line.replies[before].messages)
  }
  const seed = (costUsd: number, o: { groupId?: string; tokens?: number } = {}) =>
    h.store.seedAiUsage({ costUsd, groupId: o.groupId ?? null, inputTokens: o.tokens ?? 0, createdAt: new Date(TEST_NOW) })
  return { ...h, ga, gb, send, summarize, seed }
}

describe('Fair-use seam', () => {
  it('1 under: normal reply, no notice, LLM called once', async () => {
    const t = await setup()
    t.seed(0.1)
    const out = await t.summarize('Cga')
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('สรุป')
    expect(out.join('')).not.toContain('แจ้งเตือน')
    expect(t.llm.requests).toHaveLength(1)
    expect(t.store.tables.fair_use_notices).toHaveLength(0)
  })

  it('2 at 80%: one warning per group, group B gets its own', async () => {
    const t = await setup()
    t.seed(0.39)
    const first = await t.summarize('Cga')
    expect(first[first.length - 1]).toContain('แจ้งเตือน: ใช้ AI ไปแล้ว 82%')
    expect(t.store.tables.fair_use_notices).toHaveLength(1)
    const second = await t.summarize('Cga')
    expect(second.join('')).not.toContain('แจ้งเตือน')
    expect(t.store.tables.fair_use_notices).toHaveLength(1)
    const other = await t.summarize('Cgb')
    expect(other[other.length - 1]).toContain('แจ้งเตือน: ใช้ AI ไปแล้ว')
    expect(t.store.tables.fair_use_notices).toHaveLength(2)
  })

  it('3 at the cap: cap message only, no LLM, no usage row, no summary', async () => {
    const t = await setup()
    t.seed(0.5)
    const usageBefore = t.store.tables.ai_usage.length
    t.line.replies.length = 0
    await t.send('Cga', 'NongJoDII summarize')
    expect(t.line.replies).toHaveLength(1)
    const out = texts(t.line.replies[0].messages)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('ครบโควตา')
    expect(out[0]).toContain('1 ธันวาคม 2569')
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(usageBefore)
    expect(t.store.tables.summaries).toHaveLength(0)
  })

  it('4 over by tokens: cap message, LLM not called', async () => {
    const t = await setup()
    t.seed(0.2, { tokens: 6_100_000 })
    t.line.replies.length = 0
    await t.send('Cga', 'NongJoDII summarize')
    expect(texts(t.line.replies[0].messages)[0]).toContain('ครบโควตา')
    expect(t.llm.requests).toHaveLength(0)
  })

  it('5 crossing during a call: Summary delivered with cap message appended, next one blocked', async () => {
    const t = await setup()
    t.seed(0.49)
    const out = await t.summarize('Cga', 0.02)
    expect(out.length).toBeLessThanOrEqual(3)
    expect(out[0]).toContain('สรุป')
    expect(out[out.length - 1]).toContain('ครบโควตา')
    expect(t.store.tables.summaries).toHaveLength(1)
    t.line.replies.length = 0
    await t.send('Cga', 'NongJoDII summarize')
    expect(texts(t.line.replies[0].messages)).toHaveLength(1)
    expect(texts(t.line.replies[0].messages)[0]).toContain('ครบโควตา')
    expect(t.llm.requests).toHaveLength(1)
  })

  it('6 usage sums across groups: group B blocked', async () => {
    const t = await setup()
    t.seed(0.3, { groupId: t.ga.id })
    t.seed(0.21, { groupId: t.gb.id })
    t.line.replies.length = 0
    await t.send('Cgb', 'NongJoDII summarize')
    expect(texts(t.line.replies[0].messages)[0]).toContain('ครบโควตา')
    expect(t.llm.requests).toHaveLength(0)
  })

  it('7 month reset: blocked at 16:59Z, works at 17:00Z (Dec 1 BKK)', async () => {
    const t = await setup()
    t.seed(0.5)
    t.setNow(new Date('2026-11-30T16:59:00Z'))
    t.line.replies.length = 0
    await t.send('Cga', 'NongJoDII summarize')
    expect(texts(t.line.replies[0].messages)[0]).toContain('ครบโควตา')
    expect(t.llm.requests).toHaveLength(0)
    t.setNow(new Date('2026-11-30T17:00:00Z'))
    const out = await t.summarize('Cga')
    expect(out[0]).toContain('สรุป')
    expect(out.join('')).not.toContain('ครบโควตา')
    expect(t.llm.requests).toHaveLength(1)
  })

  it('two summaries racing for one Owner just under the cap: one model call, one charge, the other gets the cap reply', async () => {
    const t = await setup()
    t.seed(0.4995)
    // Both requests read usage before either claims (the race the claim closes).
    const read = t.store.sumOwnerMonthUsage.bind(t.store)
    let waiting = 0
    let release!: () => void
    const bothRead = new Promise<void>((r) => { release = r })
    vi.spyOn(t.store, 'sumOwnerMonthUsage').mockImplementation(async (owner, month) => {
      const out = await read(owner, month)
      if (++waiting === 2) release()
      if (waiting <= 2) await bothRead
      return out
    })
    t.llm.respond({ content: ANSWER, model: TEXT_MODEL, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001 } })
    const usageBefore = t.store.tables.ai_usage.length
    t.line.replies.length = 0
    for (const group of ['Cga', 'Cgb']) {
      const res = await handleWebhookRequest(
        signedRequest(webhookBody(ev.groupText({ text: 'NongJoDII summarize', groupId: group, userId: 'Uuser1', timestamp: t.deps.now().getTime() }))),
        t.deps, t.defer,
      )
      expect(res.status).toBe(200)
    }
    await Promise.all(t.deferred.splice(0).map((job) => job()))
    await t.runDeferred()

    expect(t.llm.requests).toHaveLength(1)
    expect(t.store.tables.ai_usage).toHaveLength(usageBefore + 1)
    expect(t.store.tables.summaries).toHaveLength(1)
    expect(t.line.replies).toHaveLength(2)
    const outs = t.line.replies.map((r) => texts(r.messages))
    const capped = outs.filter((o) => o.length === 1 && o[0].includes('ครบโควตา'))
    const summarized = outs.filter((o) => o[0].includes('สรุป') && !o[0].includes('ครบโควตา'))
    expect(capped).toHaveLength(1)
    expect(summarized).toHaveLength(1)
  })

  it('no notice and no claim when the AI call fails', async () => {
    const t = await setup()
    t.seed(0.45)
    t.llm.fail(new Error('boom'))
    t.line.replies.length = 0
    await t.send('Cga', 'NongJoDII summarize')
    expect(t.line.replies).toHaveLength(1)
    expect(texts(t.line.replies[0].messages)).toHaveLength(1)
    expect(t.store.tables.fair_use_notices).toHaveLength(0)
  })
})
