import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionsResult, LlmRequest, LlmUsage } from '@/server/ports'
import { buildPrecheckRequest, COUNT_HINT, mapPrecheck } from '@/server/summary/precheck'
import { SUMMARY_TEXT } from '@/server/summary/reply'
import { DECISION_MODEL, TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #157: one TypeSafe Jev call reads the Summary's chat first: no work means the summary only
// (no Task candidates, no review button); a count means a hint, and a short first answer gets
// one retry. A Jev failure keeps the old single text call. At most 1 Jev and 2 text calls.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0)
const MIN = 60_000
const USAGE: LlmUsage = { inputTokens: 1000, outputTokens: 200, costUsd: null }
const MEMBERS = [{ lineUserId: 'Upim', displayName: 'Pim' }, { lineUserId: 'Ubank', displayName: 'Bank' }]

function setup(opts: { draftTasks?: boolean } = {}) {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  if (opts.draftTasks === false) h.store.tables.groups.find((g) => g.id === group.id)!.featureDraftTasks = false
  const send = async (...events: Parameters<typeof webhookBody>) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  /** Chat lines with no progress word, so only the Summary reaches the models. */
  const chat = () => send(
    ev.groupText({ text: 'ต้องมีสไลด์ รายงาน และโปสเตอร์ ส่งศุกร์', userId: 'Ubank', timestamp: T0 }),
    ev.groupText({ text: 'โอเค แบ่งกันนะ', userId: 'Upim', timestamp: T0 + MIN }),
  )
  const summarize = () => send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-cmd', timestamp: T0 + 5 * MIN }))
  const answer = (titles: string[]) => h.llm.respond(() => ({
    content: JSON.stringify({ summary: 'คุยเรื่องงาน', tasks: titles.map((title) => ({ title, details: null, assignee: null, due: null, source: null, tags: [] })) }),
    model: TEXT_MODEL, usage: USAGE,
  }))
  const jev = (hasTask: number, count: string | null): DecisionsResult => ({
    model: DECISION_MODEL,
    answers: {
      has_task: { type: 'noul', noul: hasTask, confidence: 0.9 },
      task_count: count === null ? null : { type: 'choice', choice: count, probabilities: { [count]: 0.9 }, confidence: 0.9 },
    },
    usage: { inputTokens: 300, outputTokens: 0, costUsd: null },
  })
  const replyText = () => JSON.stringify(h.line.replies.find((r) => r.replyToken === 'rt-cmd')?.messages ?? [])
  const userOf = (i: number) => (h.llm.requests[i] as LlmRequest).user
  /** A model answer the Summary parser cannot read. */
  const unreadable = () => h.llm.respond(() => ({ content: 'not json {', model: TEXT_MODEL, usage: USAGE }))
  return { ...h, chat, summarize, answer, jev, replyText, userOf, unreadable }
}

describe('the Summary pre-check (#157)', () => {
  it('no work in the chat: the summary only, no candidates and no review button, one text call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.1, null))
    s.answer(['งานที่ไม่ควรมี'])
    await s.summarize()
    expect(s.decisions.requests).toHaveLength(1)
    expect(s.llm.requests).toHaveLength(1)
    expect(s.userOf(0)).toContain('found no work')
    expect(s.store.tables.task_candidates).toEqual([])
    expect(s.replyText()).toContain(SUMMARY_TEXT.none)
    expect(s.replyText()).not.toContain('view=review')
  })

  it('a count goes to the text model as a hint; enough Tasks means no retry', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'ทำโปสเตอร์'])
    await s.summarize()
    expect(s.userOf(0)).toContain(COUNT_HINT.several)
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a short first answer gets one retry, which names what the first one listed', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์'])
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'ทำโปสเตอร์'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.userOf(1)).toContain('Your first answer listed 1 task(s)')
    expect(s.userOf(1)).toContain('- ทำสไลด์')
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a retry still short keeps the longer answer and says there may be more; never a third call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน'])
    s.answer(['ทำสไลด์'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.store.tables.task_candidates).toHaveLength(2)
    expect(s.replyText()).toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('"many" with 3 Tasks is enough: no retry and no "may have more" line (Jev calls a 3-Task chat "many")', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'จองห้องซ้อม'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('an unreadable answer to the hinted prompt: the second call is the old prompt, and no third call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.unreadable()
    s.answer(['ทำสไลด์', 'เขียนรายงาน'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.userOf(0)).toContain('A first reading found')
    expect(s.userOf(1)).not.toContain('A first reading found')
    expect(s.store.tables.task_candidates).toHaveLength(2)
  })

  it('an unreadable answer with no hint fails as before (one call)', async () => {
    const s = setup()
    await s.chat()
    s.decisions.fail(new Error('down'))
    s.unreadable()
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.summaries).toEqual([])
  })

  it('a failed retry keeps the first answer', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์'])
    s.llm.fail(new Error('timeout'))
    await s.summarize()
    expect(s.store.tables.task_candidates).toHaveLength(1)
    expect(s.replyText()).toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a Jev failure or refusal keeps the old single text call, with no hint', async () => {
    for (const fail of [true, false]) {
      const s = setup()
      await s.chat()
      if (fail) s.decisions.fail(new Error('alpha api down'))
      else s.decisions.respond({ model: DECISION_MODEL, answers: { has_task: null, task_count: null }, usage: null })
      s.answer(['ทำสไลด์'])
      await s.summarize()
      expect(s.llm.requests).toHaveLength(1)
      expect(s.userOf(0)).not.toContain('A first reading found')
      expect(s.store.tables.task_candidates).toHaveLength(1)
    }
  })

  it('with Draft tasks off there is no Jev call', async () => {
    const s = setup({ draftTasks: false })
    await s.chat()
    s.answer([])
    await s.summarize()
    expect(s.decisions.requests).toHaveLength(0)
    expect(s.llm.requests).toHaveLength(1)
  })

  it('both calls are metered against the Owner', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'one'))
    s.answer(['ทำสไลด์'])
    await s.summarize()
    expect(s.store.tables.ai_usage.map((u) => u.model).sort()).toEqual([DECISION_MODEL, TEXT_MODEL].sort())
  })
})

describe('mapPrecheck and the request (#157)', () => {
  it('reads has_task against 0.5, and an unknown count as null', () => {
    expect(mapPrecheck({ has_task: { type: 'noul', noul: 0.49, confidence: null } })).toEqual({ hasTask: false })
    expect(mapPrecheck({ has_task: { type: 'noul', noul: 0.5, confidence: null }, task_count: null })).toEqual({ hasTask: true, count: null })
    expect(mapPrecheck({ has_task: null })).toBeNull()
  })

  it('asks Jev about the same chat lines the Summary reads', () => {
    const req = buildPrecheckRequest('msg1 [2026-11-12 09:00] m1: ทำสไลด์ด้วย')
    expect(req.model).toBe(DECISION_MODEL)
    expect(req.state).toContain('msg1 [2026-11-12 09:00] m1: ทำสไลด์ด้วย')
    expect(Object.keys(req.questions)).toEqual(['has_task', 'task_count'])
  })
})
