import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import type { DecisionAnswer, DecisionsResult, LlmUsage } from '@/server/ports'
import { DECIDE_TIMEOUT_MS, PROGRESS_MIN, TASK_CONFIDENCE_MIN } from '@/server/progress/decide'
import { looksLikeProgress } from '@/server/progress/keywords'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { DECISION_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, TEST_NOW, webhookBody } from './harness'
import { buttonActions } from './flex-text'

// #7 Track progress through the event seam: group text lines and button presses go in
// as signed webhooks; replies, task_prompts rows, Task rows and AI usage come out.
// #132: only a line that passes the keyword gate reaches the model.
// The decision model is TypeSafe Jev on OpenRouter's Decisions API (FakeDecisions here):
// typed answers is_progress (noul), status (choice) and task (choice, t1..tN or none).

const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const TON = 'Uton'
const JEFF = 'Ujeff'
const MEMBERS = [
  { lineUserId: BIW, displayName: 'บิว', nicknames: ['บิวตี้'] },
  { lineUserId: TON, displayName: 'ต้น', nicknames: [] },
  { lineUserId: JEFF, displayName: 'เจฟ', nicknames: [] },
]
const USAGE: LlmUsage = { inputTokens: 300, outputTokens: 0, costUsd: null }

type JevAnswers = {
  isProgress: number | null                // null = refused
  status?: 'done' | 'in_process' | null
  task?: string | null                     // 't1'..'tN' or 'none'; null = refused
  taskConfidence?: number
  probabilities?: Record<string, number>
}
/** A Decisions API result as the adapter returns it (refusals as null). */
function jev(a: JevAnswers, usage: LlmUsage = USAGE): DecisionsResult {
  const choice = (c: string, confidence: number, probabilities?: Record<string, number>): DecisionAnswer =>
    ({ type: 'choice', choice: c, probabilities: probabilities ?? { [c]: confidence }, confidence })
  return {
    model: DECISION_MODEL,
    answers: {
      is_progress: a.isProgress === null ? null : { type: 'noul', noul: a.isProgress, confidence: Math.max(a.isProgress, 1 - a.isProgress) },
      status: a.status === null ? null : choice(a.status ?? 'done', 0.9),
      task: a.task === null ? null : choice(a.task ?? 'none', a.taskConfidence ?? 0.9, a.probabilities),
    },
    usage,
  }
}
const LATER = new Date(TEST_NOW.getTime() + 60_000) // 10:01 Bangkok

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup(opts?: { owned?: boolean }) {
  const h = makeTestDeps()
  const group = opts?.owned === false
    ? h.store.seedGroup({ lineGroupId: 'Cgroup1' })
    : seedOwnedGroup(h.store, { members: MEMBERS })
  if (opts?.owned === false) for (const m of MEMBERS) h.store.seedMember({ groupId: group.id, ...m })
  // Task numbers in the prompt follow this order: 1 slides, 2 logo, 3 problem.
  const slides = h.store.seedTask({
    groupId: group.id, title: 'ทำสไลด์คู่แข่ง', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: BIW,
  })
  const logo = h.store.seedTask({ groupId: group.id, title: 'ทำโลโก้', createdByLineUserId: OWNER })
  const problem = h.store.seedTask({
    groupId: group.id, title: 'ทำสไลด์ปัญหา', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: TON,
  })

  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  const say = (userId: string, text: string, replyToken = 'rt-say') => send(ev.groupText({ text, userId, replyToken }))
  const press = (userId: string | null, data: string, eventId?: string) => {
    h.setNow(LATER)
    return send(ev.groupPostback({ data, userId, eventId, replyToken: 'rt-press' }))
  }
  // A decision in the old three-way shape, as Jev would answer it: match = progress and a
  // confident Task; ambiguous = progress, the Task unsure among those listed; none = not progress.
  const answer = (o: { kind: 'none' } | { kind: 'match'; task: number; status: 'done' | 'in_process' }
    | { kind: 'ambiguous'; tasks: number[]; status: 'done' | 'in_process' }) => {
    if (o.kind === 'none') return h.decisions.respond(jev({ isProgress: 0.1 }))
    if (o.kind === 'match') return h.decisions.respond(jev({ isProgress: 0.95, status: o.status, task: `t${o.task}`, taskConfidence: 0.9 }))
    const probabilities: Record<string, number> = { none: 0.1 }
    for (const n of o.tasks) probabilities[`t${n}`] = 0.9 / o.tasks.length
    return h.decisions.respond(jev({ isProgress: 0.9, status: o.status, task: `t${o.tasks[0]}`, taskConfidence: 0.9 / o.tasks.length, probabilities }))
  }
  const task = (id: string) => h.store.tables.tasks.find((t) => t.id === id)!
  return { ...h, group, slides, logo, problem, send, say, press, answer, task }
}

/** Every postback button of a Flex message, by label. */
function buttons(msg: LineMessage): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const action = n.action as { type?: string; label?: string; data?: string } | undefined
    if ((n.type === 'button' || n.type === 'box') && action?.type === 'postback' && action.label && action.data) out[action.label] = action.data
    Object.values(n).forEach(walk)
  }
  if (msg.type === 'flex') walk(msg.contents)
  return out
}

function lastReply(t: ReturnType<typeof setup>): LineMessage {
  const r = t.line.replies[t.line.replies.length - 1]
  expect(r).toBeDefined()
  return r.messages[0]
}

const json = (m: LineMessage) => JSON.stringify(m)

describe('a progress line that matches an open Task', () => {
  it('asks "อัปเดตงานนี้ไหม?" as a reply and stores an open card; the Task is unchanged', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ อัปไว้ในไดรฟ์แล้วนะ', 'rt-1')

    expect(t.line.replies).toHaveLength(1)
    expect(t.line.replies[0].replyToken).toBe('rt-1')
    const card = lastReply(t)
    expect(card.type).toBe('flex')
    expect(json(card)).toContain('ทำสไลด์คู่แข่ง')
    expect(json(card)).toContain('จากข้อความของ บิว · 10:00')
    expect(Object.keys(buttons(card))).toEqual(['ไม่ใช่', 'ใช่ เสร็จแล้ว', 'เลือกงานอื่น'])

    expect(t.store.tables.task_prompts).toHaveLength(1)
    expect(t.store.tables.task_prompts[0]).toMatchObject({
      taskId: t.slides.id, targetStatus: 'done', subjectLineUserId: BIW, answer: null,
      triggerMessageId: t.store.tables.messages[0].id,
    })
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('asks "<name> รับงานนี้ใช่ไหม?" when the sender takes an unowned Task', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 2, status: 'in_process' })
    await t.say(TON, 'โลโก้เดี๋ยวทำเองนะ')
    const card = lastReply(t)
    expect(json(card)).toContain('ให้ ต้น รับงานนี้ไหม?')
    expect(json(card)).toContain('ยังไม่มีกำหนดส่ง')
    expect(Object.keys(buttons(card))).toEqual(['ไม่ใช่', 'ใช่ รับงาน'])
  })

  it('matches a line that names someone by nickname, and the card shows the LINE name', async () => {
    const t = setup()
    // A model that can only tie "บิวตี้" to a Task when the nickname reached it.
    t.decisions.respond((req) =>
      jev(req.state.includes('บิวตี้') ? { isProgress: 0.95, status: 'done', task: 't1' } : { isProgress: 0.1 }))
    await t.say(TON, 'งานของบิวตี้เสร็จแล้วนะ')
    const card = lastReply(t)
    expect(json(card)).toContain('ทำสไลด์คู่แข่ง')
    expect(json(card)).toContain('จากข้อความของ ต้น')
    expect(json(card)).not.toContain('บิวตี้') // nicknames never show
    expect(t.store.tables.task_prompts[0]).toMatchObject({ taskId: t.slides.id, subjectLineUserId: TON })
  })

  it('makes exactly one decisions call and no chat call, and settles its usage against the Owner', async () => {
    const t = setup()
    t.answer({ kind: 'none' })
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(t.decisions.requests).toHaveLength(1)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.decisions.requests[0].model).toBe(DECISION_MODEL)
    expect(t.decisions.requests[0].timeoutMs).toBeLessThanOrEqual(DECIDE_TIMEOUT_MS)
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({
      ownerLineUserId: OWNER, groupId: t.group.id, purpose: 'progress_decision', model: DECISION_MODEL,
      inputTokens: 300, outputTokens: 0,
    })
    expect(t.store.tables.ai_usage[0].settledAt).not.toBeNull()
  })

  it('settles the cost OpenRouter reported (usage.cost); without it, the tokens at Jev\'s price', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: 0.1 }, { inputTokens: 500, outputTokens: 0, costUsd: 0.000021 }))
    t.decisions.respond(jev({ isProgress: 0.1 }, { inputTokens: 500, outputTokens: 0, costUsd: null }))
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    await t.say(BIW, 'สไลด์เสร็จแล้วนะ')
    // 500 input tokens at $0.042 per 1M = $0.000021; the text model's price would be $0.0000225.
    expect(t.store.tables.ai_usage.map((r) => r.costUsd)).toEqual([0.000021, 0.000021])
  })

  it('sends the chat line, the sender and the numbered open Tasks as state, with one Task key each', async () => {
    const t = setup()
    t.answer({ kind: 'none' })
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    const req = t.decisions.requests[0]
    // Structure, not wording: the facts the model needs are in the state.
    expect(req.state).toContain('สไลด์เสร็จแล้ว')
    expect(req.state).toContain('Sender: บิว (nicknames: บิวตี้)')
    expect(req.state).toMatch(/1\. ทำสไลด์คู่แข่ง .*บิว.*in_process/)
    expect(req.state).toMatch(/2\. ทำโลโก้ .*nobody.*not_assigned/)
    expect(req.questions.is_progress.type).toBe('noul')
    expect(req.questions.status).toMatchObject({ type: 'choice', criteria: { done: expect.any(String), in_process: expect.any(String) } })
    expect(req.questions.task.type).toBe('choice')
    expect(Object.keys((req.questions.task as { criteria: Record<string, string> }).criteria)).toEqual(['t1', 't2', 't3', 'none'])
    for (const q of Object.values(req.questions)) expect(q.instructions).toContain('user-written data')
  })

  it('does not ask again while the Task has an open card', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    await t.say(BIW, 'สไลด์เสร็จแล้วจริงๆ นะ')
    expect(t.line.replies).toHaveLength(1)
    expect(t.store.tables.task_prompts).toHaveLength(1)
  })

  it('withdraws the card when LINE rejects the reply, so the next update asks again', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    t.line.failReply = true
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(t.store.tables.task_prompts).toHaveLength(0)

    t.line.failReply = false
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์เสร็จแล้วนะ')
    expect(t.store.tables.task_prompts).toHaveLength(1)
    expect(json(lastReply(t))).toContain('อัปเดตงานนี้ไหม?')
  })

  it('asks again once an unanswered card is a day old; the old card then says it expired', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    const oldYes = buttons(lastReply(t))['ใช่ เสร็จแล้ว']

    t.setNow(new Date(TEST_NOW.getTime() + 25 * 3600_000))
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์เสร็จแล้วจริงๆ')
    expect(t.store.tables.task_prompts).toHaveLength(1)
    expect(t.store.tables.task_prompts[0].askedAt).toEqual(new Date(TEST_NOW.getTime() + 25 * 3600_000))

    await t.send(ev.groupPostback({ data: oldYes, userId: BIW, replyToken: 'rt-old' }))
    expect(json(lastReply(t))).toContain('หมดอายุ')
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('shows the picker when the line could mean several Tasks', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const card = lastReply(t)
    expect(json(card)).toContain('อัปเดตนี้หมายถึงงานไหน?')
    // The sender's own Task first.
    expect(Object.keys(buttons(card))).toEqual(['ทำสไลด์ปัญหา', 'ทำสไลด์คู่แข่ง', 'ไม่ใช่การอัปเดตงาน'])
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('treats a model answer that would move a Task backwards as noise', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'in_process' }) // already in process
    await t.say(BIW, 'กำลังทำสไลด์อยู่')
    expect(t.line.replies).toHaveLength(0)
  })
})

describe('answers', () => {
  async function askDone(t: ReturnType<typeof setup>, sender = BIW) {
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(sender, 'สไลด์คู่แข่งเสร็จละ')
    return buttons(lastReply(t))
  }

  it('Yes moves the Task to Done and records who answered', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ใช่ เสร็จแล้ว'])

    const task = t.task(t.slides.id)
    expect(task).toMatchObject({ status: 'done', doneAt: LATER, lastActivityAt: LATER, lastEditedByLineUserId: BIW })
    expect(t.store.tables.task_prompts[0]).toMatchObject({ answer: 'yes', answeredByLineUserId: BIW, answeredAt: LATER })
    expect(t.line.replies[1].replyToken).toBe('rt-press')
    expect(json(lastReply(t))).toContain('“ทำสไลด์คู่แข่ง” เสร็จแล้ว')
    expect(json(lastReply(t))).toContain('ยืนยันโดย บิว · 10:01')
  })

  it('No leaves the Task unchanged', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ไม่ใช่'])
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts[0].answer).toBe('no')
    expect(json(lastReply(t))).toContain('ไม่เปลี่ยนสถานะงาน')
  })

  it('Yes on In Process makes the sender the assignee', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 2, status: 'in_process' })
    await t.say(TON, 'โลโก้เดี๋ยวทำเองนะ')
    await t.press(TON, buttons(lastReply(t))['ใช่ รับงาน'])
    expect(t.task(t.logo.id)).toMatchObject({ status: 'in_process', assigneeLineUserId: TON, doneAt: null })
    expect(json(lastReply(t))).toContain('ผู้รับ: ต้น')
  })

  it('refuses someone who is neither the assignee nor the sender', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(JEFF, b['ใช่ เสร็จแล้ว'])
    expect(json(lastReply(t))).toContain('เฉพาะ บิว')
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts[0].answer).toBeNull()
  })

  it('lets the assignee answer when someone else wrote the line', async () => {
    const t = setup()
    const b = await askDone(t, TON)
    await t.press(BIW, b['ใช่ เสร็จแล้ว'])
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('a press without a userId changes nothing and replies with a LIFF login button', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(null, b['ใช่ เสร็จแล้ว'])
    const reply = lastReply(t)
    expect(reply.type).toBe('flex')
    if (reply.type !== 'flex') throw new Error('not a Flex card')
    const uri = buttonActions<{ uri: string }>(reply.contents)[0].uri
    expect(uri).toBe(`https://liff.line.me/${TEST_LIFF_ID}?view=progress&id=${encodeURIComponent(b['ใช่ เสร็จแล้ว'])}`)
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts[0].answer).toBeNull()
  })

  it('the LIFF page repeats the press as the verified LINE user', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(null, b['ใช่ เสร็จแล้ว'])
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })

    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: b['ใช่ เสร็จแล้ว'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ result: 'updated', text: '“ทำสไลด์คู่แข่ง” เสร็จแล้ว' })
    expect(t.task(t.slides.id)).toMatchObject({ status: 'done', lastEditedByLineUserId: BIW })
    expect(t.store.tables.task_prompts[0]).toMatchObject({ answer: 'yes', answeredByLineUserId: BIW })
  })

  it('the LIFF page refuses a bad token, an outsider and someone not allowed to answer', async () => {
    const t = setup()
    const b = await askDone(t)
    const yes = b['ใช่ เสร็จแล้ว']
    expect((await answerProgressFromLiff(t.deps, { idToken: 'nope', data: yes })).status).toBe(401)

    t.line.idTokens.set('tok-out', { lineUserId: 'Uoutsider', displayName: 'X' }) // LINE: not in the group
    expect((await answerProgressFromLiff(t.deps, { idToken: 'tok-out', data: yes })).status).toBe(403)

    t.line.idTokens.set('tok-jeff', { lineUserId: JEFF, displayName: 'เจฟ' })
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-jeff', data: yes })
    expect(res.body).toMatchObject({ result: 'refused' })
    expect(t.task(t.slides.id).status).toBe('in_process')

    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
    expect((await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: 'a=pg&p=not-a-uuid&v=y' })).status).toBe(400)
  })

  it('reopening the LIFF link of "ผิดงาน" shows the picker again, and a pick there finishes', async () => {
    const t = setup()
    const b = await askDone(t)
    const wrong = b['เลือกงานอื่น']
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })

    const first = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: wrong })
    expect(first.body).toMatchObject({ result: 'picker' })
    expect(t.store.tables.task_prompts[0].answer).toBe('no')

    // The pick failed on the client side, so the person reopens the same link.
    const again = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: wrong })
    expect(again.body).toMatchObject({ result: 'picker' })
    const choices = (again.body as { choices: { label: string; data: string }[] }).choices
    expect(choices.map((c) => c.label)).toContain('ทำโลโก้')

    const logo = choices.find((c) => c.label === 'ทำโลโก้')!
    const done = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: logo.data })
    expect(done.body).toMatchObject({ result: 'updated' })
    expect(t.task(t.logo.id).status).toBe('done')
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('a second "ผิดงาน" press in the chat shows the picker again; after a Yes it does not', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['เลือกงานอื่น'], 'ev-w1')
    await t.press(BIW, b['เลือกงานอื่น'], 'ev-w2')
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(t.store.tables.task_prompts).toHaveLength(1)

    const t2 = setup()
    const b2 = await askDone(t2)
    await t2.press(BIW, b2['ใช่ เสร็จแล้ว'], 'ev-y')
    await t2.press(BIW, b2['เลือกงานอื่น'], 'ev-w')
    expect(json(lastReply(t2))).toContain('งานนี้ถูกปิดไปแล้ว')
  })

  it('a pick whose write fails can be pressed again', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const pick = buttons(lastReply(t))['ทำสไลด์ปัญหา']

    t.store.failNext('confirmProgressYes')
    await t.press(TON, pick, 'ev-p1')
    expect(t.task(t.problem.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts).toHaveLength(0) // the unanswered row was withdrawn

    await t.press(TON, pick, 'ev-p2')
    expect(t.task(t.problem.id).status).toBe('done')
    expect(json(lastReply(t))).toContain('“ทำสไลด์ปัญหา” เสร็จแล้ว')
  })

  it('a pick retried after both the write and the clean-up failed reuses its row', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const pick = buttons(lastReply(t))['ทำสไลด์ปัญหา']

    t.store.failNext('confirmProgressYes')
    t.store.failNext('withdrawProgressPrompt')
    await t.press(TON, pick, 'ev-p1')
    expect(t.store.tables.task_prompts).toHaveLength(1)
    expect(t.store.tables.task_prompts[0].answer).toBeNull()

    await t.press(TON, pick, 'ev-p2')
    expect(t.task(t.problem.id).status).toBe('done')
    expect(t.store.tables.task_prompts).toHaveLength(1)
    expect(t.store.tables.task_prompts[0]).toMatchObject({ answer: 'yes', answeredByLineUserId: TON })
  })

  it('a pick does not take over a real card that is still open for the Task', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 3, status: 'done' })
    await t.say(TON, 'สไลด์ปัญหาเสร็จแล้ว')               // real card for Task 3
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'อีกอันก็เสร็จแล้ว')
    await t.press(TON, buttons(lastReply(t))['ทำสไลด์ปัญหา'])
    expect(json(lastReply(t))).toContain('มีการ์ดถามงานนี้อยู่แล้ว')
    expect(t.task(t.problem.id).status).toBe('in_process')
  })

  it('a failed write on Yes leaves the card usable', async () => {
    const t = setup()
    const b = await askDone(t)
    t.store.failNext('confirmProgressYes')
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-yes-1')
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts[0].answer).toBeNull()

    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-yes-2')
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('a Yes from someone who lost the right to answer mid-press is refused by the write', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(TON, 'สไลด์คู่แข่งเสร็จละ')              // card on Task 1 (assignee BIW), sent by TON
    const yes = buttons(lastReply(t))['ใช่ เสร็จแล้ว']

    // Between the handler's check and the write, someone reassigns the Task to JEFF.
    const original = t.store.confirmProgressYes.bind(t.store)
    t.store.confirmProgressYes = async (y) => {
      t.task(t.slides.id).assigneeLineUserId = JEFF
      return original(y)
    }
    await t.press(BIW, yes, 'ev-race')

    expect(json(lastReply(t))).toContain('ถูกลบหรือเปลี่ยนไปแล้ว')
    expect(t.task(t.slides.id)).toMatchObject({ status: 'in_process', assigneeLineUserId: JEFF })
    expect(t.store.tables.task_prompts[0].answer).toBeNull()
  })

  it('a press whose group write failed still runs when LINE redelivers it', async () => {
    const t = setup()
    const b = await askDone(t)
    t.setNow(LATER)
    const press = ev.groupPostback({ data: b['ใช่ เสร็จแล้ว'], userId: BIW, eventId: 'ev-retry', replyToken: 'rt-press' })
    t.store.failNext('ensureGroup')
    const first = await handleWebhookRequest(signedRequest(webhookBody(press)), t.deps, t.defer)
    expect(first.status).toBe(500)
    await t.runDeferred()
    expect(t.task(t.slides.id).status).toBe('in_process')

    await t.send({ ...press, deliveryContext: { isRedelivery: true } })
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('a second press on a card that closed its Task says the Task is already closed', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-1')
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-2')
    expect(json(lastReply(t))).toContain('งานนี้ถูกปิดไปแล้ว')
    await t.press(BIW, b['ไม่ใช่'], 'ev-3')
    expect(json(lastReply(t))).toContain('งานนี้ถูกปิดไปแล้ว')
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('a card answered No still says it was already answered', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ไม่ใช่'], 'ev-1')
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-2')
    expect(json(lastReply(t))).toContain('การ์ดนี้มีคนตอบไปแล้ว')
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('Yes on a card whose Task was closed another way says the Task is already closed', async () => {
    const t = setup()
    const b = await askDone(t)
    t.task(t.slides.id).status = 'done'
    await t.press(BIW, b['ใช่ เสร็จแล้ว'])
    expect(json(lastReply(t))).toContain('งานนี้ถูกปิดไปแล้ว')
  })

  it('a redelivered press runs once', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-press')
    await t.press(BIW, b['ใช่ เสร็จแล้ว'], 'ev-press')
    expect(t.line.replies).toHaveLength(2) // the card, then one result
  })

  it('does nothing to a Task deleted after the card was posted', async () => {
    const t = setup()
    const b = await askDone(t)
    t.task(t.slides.id).deletedAt = TEST_NOW
    await t.press(BIW, b['ใช่ เสร็จแล้ว'])
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(json(lastReply(t))).toContain('ถูกลบหรือเปลี่ยนไปแล้ว')
  })

  it('"ผิดงาน" closes the card and offers the other Tasks', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['เลือกงานอื่น'])
    expect(t.store.tables.task_prompts[0].answer).toBe('no')
    const picker = buttons(lastReply(t))
    expect(Object.keys(picker)).not.toContain('ทำสไลด์คู่แข่ง')

    await t.press(BIW, picker['ทำโลโก้'])
    expect(t.task(t.logo.id).status).toBe('done')
    expect(t.store.tables.task_prompts[1]).toMatchObject({ taskId: t.logo.id, answer: 'yes', subjectLineUserId: BIW })
  })

  it('a pick on the picker moves the Task; only the sender or the assignee may pick', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))

    await t.press(JEFF, b['ทำสไลด์ปัญหา'])
    expect(t.task(t.problem.id).status).toBe('in_process')

    await t.press(TON, b['ทำสไลด์ปัญหา'])
    expect(t.task(t.problem.id).status).toBe('done')

    await t.press(TON, b['ทำสไลด์ปัญหา'])
    expect(json(lastReply(t))).toContain('งานนี้ถูกปิดไปแล้ว')
  })

  it('"ไม่ใช่การอัปเดตงาน" changes nothing and closes the picker: its Task buttons no longer work', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))
    await t.press(TON, b['ไม่ใช่การอัปเดตงาน'], 'ev-dismiss')
    expect(json(lastReply(t))).toContain('ไม่ใช่การอัปเดตงาน')
    expect(t.store.tables.messages[0].progressDismissedAt).toEqual(LATER)

    // ต้น is the assignee of Task 3, but the picker is closed.
    await t.press(TON, b['ทำสไลด์ปัญหา'], 'ev-pick-3')
    expect(json(lastReply(t))).toContain('รายการนี้ปิดไปแล้ว')
    await t.press(BIW, b['ทำสไลด์คู่แข่ง'], 'ev-pick-1')
    expect(json(lastReply(t))).toContain('รายการนี้ปิดไปแล้ว')
    expect(t.task(t.problem.id).status).toBe('in_process')
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('only the sender of the line may press "ไม่ใช่การอัปเดตงาน"; a press without a userId goes to LIFF', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))

    await t.press(JEFF, b['ไม่ใช่การอัปเดตงาน'], 'ev-d1')
    expect(json(lastReply(t))).toContain('เฉพาะ ต้น ที่ปิดรายการนี้ได้')
    await t.press(null, b['ไม่ใช่การอัปเดตงาน'], 'ev-d2')
    expect(lastReply(t).type).toBe('flex')
    expect(json(lastReply(t))).toContain('ยืนยันตัวตนก่อนนะ')
    expect(t.store.tables.messages[0].progressDismissedAt ?? null).toBeNull()

    // Still open: a pick works.
    await t.press(TON, b['ทำสไลด์ปัญหา'], 'ev-pick')
    expect(t.task(t.problem.id).status).toBe('done')
  })

  it('"ผิดงาน" after its picker was closed does not show the picker again', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    const wrong = buttons(lastReply(t))['เลือกงานอื่น']
    await t.press(BIW, wrong, 'ev-w1')
    const picker = buttons(lastReply(t))
    await t.press(BIW, picker['ไม่ใช่การอัปเดตงาน'], 'ev-d')
    await t.press(BIW, wrong, 'ev-w2')
    expect(json(lastReply(t))).toContain('รายการนี้ปิดไปแล้ว')
    await t.press(BIW, picker['ทำโลโก้'], 'ev-p')
    expect(t.task(t.logo.id).status).toBe('not_assigned')
  })

  // #87: the reverse order. A pick lands first, then "ไม่ใช่การอัปเดตงาน" on the same picker.
  it('a pick, then "ไม่ใช่การอัปเดตงาน": says the Task was already updated, offers to fix it, undoes nothing', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))
    await t.press(TON, b['ทำสไลด์ปัญหา'], 'ev-pick')
    expect(t.task(t.problem.id).status).toBe('done')

    await t.press(TON, b['ไม่ใช่การอัปเดตงาน'], 'ev-dismiss')
    const reply = lastReply(t)
    expect(reply.type).toBe('flex')
    expect(json(reply)).toContain('อัปเดต “ทำสไลด์ปัญหา” เป็นเสร็จไปแล้ว')
    expect(json(reply)).not.toContain('โอเค ไม่ใช่การอัปเดตงาน') // nothing claims it was undone
    expect(json(reply)).toContain(`https://liff.line.me/${TEST_LIFF_ID}?view=task&id=${t.problem.id}`)
    expect(t.task(t.problem.id).status).toBe('done')

    // The rest of the picker is closed now.
    await t.press(BIW, b['ทำสไลด์คู่แข่ง'], 'ev-pick-2')
    expect(json(lastReply(t))).toContain('รายการนี้ปิดไปแล้ว')
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('a second "ไม่ใช่การอัปเดตงาน" changes nothing, in either order', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))
    await t.press(TON, b['ไม่ใช่การอัปเดตงาน'], 'ev-d1')
    const firstAt = t.store.tables.messages[0].progressDismissedAt
    t.setNow(new Date(LATER.getTime() + 60_000))
    await t.press(TON, b['ไม่ใช่การอัปเดตงาน'], 'ev-d2')
    expect(json(lastReply(t))).toContain('ไม่ใช่การอัปเดตงาน')
    expect(t.store.tables.messages[0].progressDismissedAt).toEqual(firstAt)
    expect(t.store.tables.task_prompts).toHaveLength(0)
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.task(t.problem.id).status).toBe('in_process')

    // After a pick: the repeat gives the same "already updated" answer and changes nothing.
    const t2 = setup()
    t2.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t2.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b2 = buttons(lastReply(t2))
    await t2.press(TON, b2['ทำสไลด์ปัญหา'], 'ev-p')
    await t2.press(TON, b2['ไม่ใช่การอัปเดตงาน'], 'ev-d1')
    await t2.press(TON, b2['ไม่ใช่การอัปเดตงาน'], 'ev-d2')
    expect(json(lastReply(t2))).toContain('อัปเดต “ทำสไลด์ปัญหา” เป็นเสร็จไปแล้ว')
    expect(t2.task(t2.problem.id).status).toBe('done')
    expect(t2.store.tables.task_prompts.filter((p) => p.answer === 'yes')).toHaveLength(1)
  })

  it('a Yes that reaches the database after "ไม่ใช่การอัปเดตงาน" is refused there', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const b = buttons(lastReply(t))
    // The pick passed the app's check, then the dismissal committed before its write.
    const msgId = t.store.tables.messages[0].id
    const { prompt } = await t.store.createProgressPrompt({
      groupId: t.group.id, taskId: t.problem.id, targetStatus: 'done', subjectLineUserId: TON,
      triggerMessageId: msgId, askedAt: TEST_NOW,
    })
    await t.press(TON, b['ไม่ใช่การอัปเดตงาน'], 'ev-d')
    const { outcome } = await t.store.confirmProgressYes({
      promptId: prompt!.id, taskId: t.problem.id, fromStatus: 'in_process', toStatus: 'done',
      byLineUserId: TON, assignTo: null, at: LATER,
    })
    expect(outcome).toBe('dismissed')
    expect(t.task(t.problem.id).status).toBe('in_process')
  })

  it('ignores postbacks of other features', async () => {
    const t = setup()
    await t.press(BIW, 'a=assign&t=x')
    expect(t.line.replies).toHaveLength(0)
  })
})

const NOT_PROGRESS = [
  'ใครว่างไปกินข้าวบ้าง', 'เที่ยงนี้กินอะไรดี', 'ฝนจะตกแล้ว', 'พรุ่งนี้ประชุมกี่โมง', 'สไลด์อยู่ในไดรฟ์นะ',
  'ขอบคุณครับ', '555', 'เมื่อคืนดูบอลไหม', 'ok ครับ', 'ฝากดูโลโก้ให้หน่อย',
]

describe('the keyword gate (#132)', () => {
  it.each([
    'เสร็จแล้ว', 'เสร็จละ', 'ทำเสร็จละ', 'เสร็จเรียบร้อย', 'เรียบร้อยครับ', 'ส่งไฟล์แล้ว', 'ส่งงานแล้ว',
    'อัปไดรฟ์แล้ว', 'อัพไดรฟ์แล้วนะ', 'อัปโหลดเสร็จ', 'ส่งแล้ว', 'Done', 'finished the slides',
  ])('"%s" reads as done', (line) => {
    expect(looksLikeProgress(line)).toBe('done')
  })

  it.each([
    'เดี๋ยวทำเอง', 'เริ่มทำแล้ว', 'กำลังทำอยู่', 'รับไปนะ', 'started',
    // E2E round 2, step 3.5: taking a Task without the word ทำ.
    'เดี๋ยวเราจองห้องประชุมให้เอง', 'เรื่องห้องเดี๋ยวจัดการเอง', 'อันนี้เรารับเองนะ',
  ])('"%s" reads as started', (line) => {
    expect(looksLikeProgress(line)).toBe('in_process')
  })

  it.each(['ยังไม่เสร็จ', 'สไลด์ไม่เสร็จแน่เลย', 'not done', 'สไลด์เสร็จยัง', 'ต้องเสร็จเมื่อไหร่ครับ', ...NOT_PROGRESS])(
    '"%s" does not pass', (line) => {
      expect(looksLikeProgress(line)).toBeNull()
    })

  it('ten lines without a progress word make no model call and get no reply', async () => {
    const t = setup()
    const decideSpy = vi.spyOn(t.decisions, 'decide')
    for (const line of NOT_PROGRESS) await t.say(BIW, line)
    expect(decideSpy).not.toHaveBeenCalled()
    expect(t.store.tables.ai_usage).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.messages).toHaveLength(NOT_PROGRESS.length)
  })

  it('"ยังไม่เสร็จ" makes no model call and gets no reply', async () => {
    const t = setup()
    await t.say(BIW, 'สไลด์ยังไม่เสร็จเลย')
    expect(t.decisions.requests).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
  })

  it('"เสร็จแล้ว" makes exactly one model call, and the card follows its answer', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จแล้ว')
    expect(t.decisions.requests).toHaveLength(1)
    expect(t.llm.requests).toHaveLength(0)
    expect(json(lastReply(t))).toContain('อัปเดตงานนี้ไหม?')
    expect(t.store.tables.task_prompts[0]).toMatchObject({ taskId: t.slides.id, targetStatus: 'done' })
  })

  it('a keyword line the model calls not progress gets no card', async () => {
    const t = setup()
    t.answer({ kind: 'none' })
    await t.say(BIW, 'เสร็จแล้วค่อยไปกินข้าวกัน')
    expect(t.decisions.requests).toHaveLength(1)
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })
})

describe('noise', () => {
  it('gets no reply and no model call', async () => {
    const t = setup()
    await t.say(BIW, 'ใครว่างไปกินข้าวบ้าง')
    expect(t.decisions.requests).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('skips bot commands, a turned-off feature and groups with no open Tasks, without an AI call', async () => {
    const t = setup()
    await t.say(BIW, 'NongJoDII done')
    // "NongJoDII done" is the reminder fallback (#45), which answers it itself; it is never
    // read as a progress line, so no progress card and no AI call.
    expect(t.line.replies.map((r) => JSON.stringify(r.messages))).not.toContainEqual(expect.stringContaining('อัปเดตงานนี้ไหม?'))
    t.line.replies = []
    t.store.tables.groups[0].featureTrackRemind = false
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    t.store.tables.groups[0].featureTrackRemind = true
    for (const task of t.store.tables.tasks) task.status = 'done'
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(t.decisions.requests).toHaveLength(0)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
  })
})

describe('mapping Jev\'s answers (thresholds: is_progress ' + PROGRESS_MIN + ', task confidence ' + TASK_CONFIDENCE_MIN + ')', () => {
  it('match: progress and a confident Task give the "Mark as Done?" card for that Task', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: 0.8, status: 'done', task: 't3', taskConfidence: TASK_CONFIDENCE_MIN }))
    await t.say(TON, 'สไลด์ปัญหาเสร็จแล้ว')
    expect(json(lastReply(t))).toContain('อัปเดตงานนี้ไหม?')
    expect(t.store.tables.task_prompts[0]).toMatchObject({ taskId: t.problem.id, targetStatus: 'done' })
  })

  it('unsure: a Task below the confidence line gives the picker of the likely Tasks', async () => {
    const t = setup()
    t.decisions.respond(jev({
      isProgress: 0.9, status: 'done', task: 't1', taskConfidence: 0.55,
      probabilities: { t1: 0.55, t3: 0.4, t2: 0.03, none: 0.02 },
    }))
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(Object.keys(buttons(lastReply(t)))).toEqual(['ทำสไลด์ปัญหา', 'ทำสไลด์คู่แข่ง', 'ไม่ใช่การอัปเดตงาน'])
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('unsure: the sender\'s own open Task is offered even when the model gave it little weight (E2E 3.6)', async () => {
    const t = setup()
    // บิว owns ทำสไลด์คู่แข่ง (t1); the model leaned to the unowned logo and the problem slides.
    t.decisions.respond(jev({
      isProgress: 0.9, status: 'done', task: 't2', taskConfidence: 0.5,
      probabilities: { t2: 0.5, t3: 0.45, t1: 0.03, none: 0.02 },
    }))
    await t.say(BIW, 'จองเสร็จแล้วนะ')
    expect(Object.keys(buttons(lastReply(t)))).toEqual(['ทำสไลด์คู่แข่ง', 'ทำโลโก้', 'ทำสไลด์ปัญหา', 'ไม่ใช่การอัปเดตงาน'])
  })

  it('unsure: progress that fits no listed Task gives the picker, never a card', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: 0.9, status: 'done', task: 'none', taskConfidence: 0.95 }))
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('none: is_progress below the line gets no reply, even when the other answers were refused', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: PROGRESS_MIN - 0.01, status: null, task: null }))
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })
})

describe('when the decision model does not answer (F3.4: fail, then picker)', () => {
  it('a refused is_progress gives the free picker, never a "not progress" verdict', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: null, status: 'done', task: 't1' }))
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(t.llm.requests).toHaveLength(0)
  })

  it('a refused or missing task answer gives the picker', async () => {
    const t = setup()
    t.decisions.respond(jev({ isProgress: 0.9, status: 'done', task: null }))
    t.decisions.respond({ model: DECISION_MODEL, answers: { is_progress: { type: 'noul', noul: 0.9, confidence: 0.9 } }, usage: USAGE })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ', 'rt-a')
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละนะ', 'rt-b')
    expect(t.line.replies.map((r) => json(r.messages[0]))).toEqual([
      expect.stringContaining('อัปเดตนี้หมายถึงงานไหน?'), expect.stringContaining('อัปเดตนี้หมายถึงงานไหน?'),
    ])
  })

  it('an adapter error gives the picker, makes no chat-model call, and is not charged; the message is kept', async () => {
    const t = setup()
    t.decisions.fail(new Error('openrouter decisions 503'))
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.decisions.requests).toHaveLength(1)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(0)
    const picker = buttons(lastReply(t))
    expect(Object.keys(picker)[0]).toBe('ทำสไลด์คู่แข่ง') // the sender's own Task first
    expect(t.store.tables.messages).toHaveLength(1)

    await t.press(BIW, picker['ทำสไลด์คู่แข่ง'])
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('uses the keyword status for the picker: a started word offers the Tasks nobody owns', async () => {
    const t = setup()
    t.decisions.fail(new Error('openrouter decisions timeout'))
    await t.say(TON, 'โลโก้เดี๋ยวทำเองนะ')
    expect(Object.keys(buttons(lastReply(t)))).toEqual(['ทำโลโก้', 'ไม่ใช่การอัปเดตงาน'])
    expect(t.decisions.requests).toHaveLength(1)
  })
})

describe('without AI', () => {
  it('at the Fair-use cap, uses the free keyword check and makes no model call', async () => {
    const t = setup()
    t.store.seedAiUsage({ ownerLineUserId: OWNER, groupId: t.group.id, inputTokens: 6_000_000, costUsd: 0.5 })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.decisions.requests).toHaveLength(0)
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
  })

  it('in a group without a confirmed Owner, a keyword line gets the picker with no model call', async () => {
    const t = setup({ owned: false })
    const decideSpy = vi.spyOn(t.decisions, 'decide')
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(decideSpy).not.toHaveBeenCalled()
    expect(t.decisions.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(0)
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
  })
})
