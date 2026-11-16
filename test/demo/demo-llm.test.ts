import { describe, expect, it } from 'vitest'
import { CANNED_MODEL, DemoLlm, findDue } from '@/server/demo/demo-llm'
import type { DecisionsPort, LlmPort, LlmRequest } from '@/server/ports'
import { SUMMARY_SCHEMA, parseSummaryOutput } from '@/server/summary/parse-output'
import { buildSummaryPrompt } from '@/server/summary/prompt'
import { buildDecisionsRequest, mapDecision } from '@/server/progress/decide'
import type { TaskRow } from '@/server/ports'

const NOW = new Date('2026-11-16T03:00:00Z') // Monday 10:00 in Bangkok
const at = (min: number) => new Date(NOW.getTime() + min * 60_000)
const msg = (id: number, sender: string, name: string, text: string) => ({
  id: `s${id}`, lineMessageId: `l${id}`, senderLineUserId: sender, senderDisplayName: name, text, mentions: null, sentAt: at(id),
})

function summaryRequest(): LlmRequest {
  const prompt = buildSummaryPrompt({
    now: NOW, workDescription: 'พิตช์',
    members: [
      { lineUserId: 'U1', displayName: 'Nont', nicknames: ['นนท์'], role: 'manager' },
      { lineUserId: 'U3', displayName: 'Bomb', nicknames: ['บอม'], role: 'designer' },
    ] as never,
    messages: [
      msg(1, 'U1', 'Nont', 'สไลด์ยังเป็นของรอบแรกอยู่เลย'),
      msg(2, 'U1', 'Nont', 'ฝากบอมอัปเดตสไลด์พิตช์ทั้งเด็คด้วยนะ'),
      msg(3, 'U1', 'Nont', 'ขอภายในพรุ่งนี้ห้าโมงเย็นนะ'),
    ] as never,
  })
  return { model: 'm', system: prompt.system, user: prompt.user, maxTokens: 4000, schema: SUMMARY_SCHEMA }
}

const ask0 = () => buildDecisionsRequest({ text: 'เสร็จแล้ว', senderLineUserId: 'U1', members: [], tasks: [], workDescription: null })

const throwing: LlmPort = { complete: async () => { throw new Error('openrouter 500') } }

describe('DemoLlm', () => {
  it('falls back to a valid canned Summary when the model throws', async () => {
    const llm = new DemoLlm({ inner: throwing })
    const res = await llm.complete(summaryRequest())
    expect(llm.lastCallFallback).toBe(true)
    expect(llm.busy).toBe(false)
    expect(res.model).toBe(CANNED_MODEL)
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
    const parsed = parseSummaryOutput(res.content)
    expect(parsed.summary).not.toBe('')
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.tasks[0]).toMatchObject({ title: 'อัปเดตสไลด์พิตช์ทั้งเด็ค', assigneeRef: 'm2', sourceRef: 'msg2' })
    expect(parsed.tasks[0].due?.toISOString()).toBe('2026-11-17T10:00:00.000Z')
  })

  it('falls back with no key, and when the model is too slow', async () => {
    expect(JSON.parse((await new DemoLlm({ inner: null }).complete(summaryRequest())).content).summary).toBeTruthy()
    const slow: LlmPort = { complete: () => new Promise(() => {}) }
    const llm = new DemoLlm({ inner: slow, timeoutMs: 20 })
    const res = await llm.complete(summaryRequest())
    expect(llm.lastCallFallback).toBe(true)
    expect(parseSummaryOutput(res.content).tasks).toHaveLength(1)
  })

  it('on a failed progress decision, answers from the chat line\'s keywords: the first Task, recorded as a fallback', async () => {
    const failing: DecisionsPort = { decide: async () => { throw new Error('openrouter decisions 500') } }
    const llm = new DemoLlm({ inner: null, decisions: failing })
    llm.clock = () => NOW
    const tasks = [
      { id: 'a', title: 'ทำสไลด์เสร็จสิ้น', status: 'in_process', assigneeLineUserId: null },
      { id: 'b', title: 'ทำโลโก้', status: 'not_assigned', assigneeLineUserId: null },
    ] as TaskRow[]
    const ask = (text: string) => buildDecisionsRequest({ text, senderLineUserId: 'U1', members: [], tasks, workDescription: null })

    const done = await llm.decide(ask('สไลด์อัปแล้วนะ เสร็จแล้ว'))
    expect(done.model).toBe(CANNED_MODEL)
    expect(done.answers.is_progress).toMatchObject({ type: 'noul', noul: 0.9 })
    expect(mapDecision(done.answers, tasks)).toEqual({ kind: 'match', taskId: 'a', status: 'done' })
    // A Task title with a progress word does not make ordinary chat look like progress.
    const chat = await llm.decide(ask('กินข้าวกันไหม'))
    expect(mapDecision(chat.answers, tasks)).toEqual({ kind: 'none' })

    expect(llm.lastCallFallback).toBe(true)
    expect(llm.calls).toMatchObject([
      { kind: 'progress', model: CANNED_MODEL, costUsd: 0, fallback: true },
      { kind: 'progress', model: CANNED_MODEL, costUsd: 0, fallback: true },
    ])
  })

  it('records a real progress decision with its reported cost', async () => {
    const real: DecisionsPort = {
      decide: async () => ({ model: 'typesafe/jev-1.14', answers: {}, usage: { inputTokens: 400, outputTokens: 0, costUsd: 0.0000168 } }),
    }
    const llm = new DemoLlm({ inner: null, decisions: real })
    await llm.decide(ask0())
    expect(llm.lastCallFallback).toBe(false)
    expect(llm.calls).toMatchObject([
      { kind: 'progress', model: 'typesafe/jev-1.14', inputTokens: 400, outputTokens: 0, costUsd: 0.0000168, estimated: false, fallback: false },
    ])
    expect(llm.totalUsd).toBeCloseTo(0.0000168, 12)
  })

  it('passes a real answer through', async () => {
    const real: LlmPort = { complete: async () => ({ content: '{"summary":"ok","tasks":[]}', model: 'real/model', usage: null }) }
    const llm = new DemoLlm({ inner: real })
    const res = await llm.complete(summaryRequest())
    expect(res.model).toBe('real/model')
    expect(llm.lastCallFallback).toBe(false)
    expect(llm.model).toBe('real/model')
  })

  it('reads Thai deadlines', () => {
    expect(findDue('ส่งพรุ่งนี้ 18:00', '2026-11-16')).toBe('2026-11-17T18:00:00+07:00')
    expect(findDue('ก่อนวันศุกร์นี้นะ', '2026-11-16')).toBe('2026-11-20T17:00:00+07:00')
    expect(findDue('วันพฤหัส บ่ายโมง', '2026-11-16')).toBe('2026-11-19T13:00:00+07:00')
    expect(findDue('เที่ยงนี้กินอะไรดี', '2026-11-16')).toBeNull()
  })

  it('records each call (kind, model, tokens, cost) and keeps a running total', async () => {
    const answers = [
      { content: '{"summary":"ok","tasks":[]}', model: 'real/model', usage: { inputTokens: 1200, outputTokens: 80, costUsd: 0.000068 } },
      { content: '{"kind":"none"}', model: 'real/model', usage: { inputTokens: 1000, outputTokens: 0, costUsd: null } },
      { content: '{}', model: 'real/model', usage: null },
    ]
    const fake: LlmPort = { complete: async () => answers.shift()! }
    const llm = new DemoLlm({ inner: fake })
    llm.clock = () => NOW
    await llm.complete(summaryRequest())
    await llm.complete({ model: 'm', system: 's', user: 'u', maxTokens: 10 })
    await llm.complete({ model: 'm', system: 'Suggest tags for the task', user: 'u', maxTokens: 10 })
    await new DemoLlm({ inner: throwing }).complete(summaryRequest()) // another instance: not counted here
    expect(llm.calls).toMatchObject([
      { at: NOW.toISOString(), kind: 'summary', model: 'real/model', inputTokens: 1200, outputTokens: 80, costUsd: 0.000068, estimated: false, fallback: false },
      { at: NOW.toISOString(), kind: 'other', model: 'real/model', inputTokens: 1000, outputTokens: 0, costUsd: expect.any(Number), estimated: true, fallback: false },
      { at: NOW.toISOString(), kind: 'tags', model: 'real/model', inputTokens: 0, outputTokens: 0, costUsd: null, estimated: false, fallback: false },
    ])
    expect(llm.calls[1].costUsd).toBeGreaterThan(0)
    expect(new Set(llm.calls.map((c) => c.id)).size).toBe(3)
    expect(llm.totalUsd).toBeCloseTo(0.000068 + (llm.calls[1].costUsd as number), 12)

    const offline = new DemoLlm({ inner: throwing })
    await offline.complete(summaryRequest())
    expect(offline.calls).toMatchObject([{ kind: 'summary', model: CANNED_MODEL, costUsd: 0, fallback: true }])
    expect(offline.totalUsd).toBe(0)
    offline.clearCalls()
    expect(offline.calls).toEqual([])
  })
})
