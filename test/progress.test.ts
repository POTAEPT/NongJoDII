import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import type { LlmUsage } from '@/server/ports'
import { DECIDE_CALL_MAX_MS, decide } from '@/server/progress/decide'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { DECISION_MODEL, TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, TEST_NOW, webhookBody } from './harness'

// #7 Track progress through the event seam: group text lines and button presses go in
// as signed webhooks; replies, task_prompts rows, Task rows and AI usage come out.

const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const TON = 'Uton'
const JEFF = 'Ujeff'
const MEMBERS = [
  { lineUserId: BIW, displayName: 'บิว', nicknames: ['บิวตี้'] },
  { lineUserId: TON, displayName: 'ต้น', nicknames: [] },
  { lineUserId: JEFF, displayName: 'เจฟ', nicknames: [] },
]
const USAGE: LlmUsage = { inputTokens: 300, outputTokens: 20, costUsd: null }
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
  const answer = (obj: unknown) => h.llm.respond({ content: JSON.stringify(obj), model: TEXT_MODEL, usage: USAGE })
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
    if (n.type === 'button' && action?.type === 'postback' && action.label && action.data) out[action.label] = action.data
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
    expect(Object.keys(buttons(card))).toEqual(['ยังไม่เสร็จ', 'ใช่ เสร็จแล้ว', 'ผิดงาน · เลือกงานอื่น'])

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
    await t.say(TON, 'เดี๋ยวเราทำโลโก้เอง')
    const card = lastReply(t)
    expect(json(card)).toContain('ต้น รับงานนี้ใช่ไหม?')
    expect(json(card)).toContain('ยังไม่มีกำหนดส่ง')
    expect(Object.keys(buttons(card))).toEqual(['ไม่รับ', 'ใช่ รับงาน'])
  })

  it('matches a line that names someone by nickname, and the card shows the LINE name', async () => {
    const t = setup()
    // A model that can only tie "บิวตี้" to a Task when the nickname reached it.
    t.llm.respond((req) => ({
      content: JSON.stringify(req.user.includes('บิวตี้') ? { kind: 'match', task: 1, status: 'done' } : { kind: 'none' }),
      model: TEXT_MODEL, usage: USAGE,
    }))
    await t.say(TON, 'งานของบิวตี้เสร็จแล้วนะ')
    const card = lastReply(t)
    expect(json(card)).toContain('ทำสไลด์คู่แข่ง')
    expect(json(card)).toContain('จากข้อความของ ต้น')
    expect(json(card)).not.toContain('บิวตี้') // nicknames never show
    expect(t.store.tables.task_prompts[0]).toMatchObject({ taskId: t.slides.id, subjectLineUserId: TON })
  })

  it('uses the decision model, inside the time budget, and records usage against the Owner', async () => {
    const t = setup()
    t.answer({ kind: 'none' })
    await t.say(BIW, 'กินข้าวยัง')
    expect(t.llm.requests).toHaveLength(1)
    expect(t.llm.requests[0].model).toBe(DECISION_MODEL)
    expect(t.llm.requests[0].timeoutMs).toBeLessThanOrEqual(DECIDE_CALL_MAX_MS)
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({
      ownerLineUserId: OWNER, groupId: t.group.id, purpose: 'progress_decision', inputTokens: 300, outputTokens: 20,
    })
    expect(t.store.tables.ai_usage[0].settledAt).not.toBeNull()
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

  it('skips the fallback model when the time budget is used up, and the keyword picker answers', async () => {
    const t = setup()
    // The decision model times out after 31 s of the 35 s budget: 4 s are left, too few for a call.
    let elapsed = 0
    t.llm.respond(() => {
      elapsed = 31_000
      throw new Error('openrouter timeout')
    })
    const decision = await decide(
      t.deps, { ownerLineUserId: OWNER, projectId: t.group.projectId, groupId: t.group.id },
      { text: 'สไลด์เสร็จแล้ว', senderLineUserId: BIW, members: [], tasks: await t.store.listOpenTasks(t.group.id), workDescription: null },
      () => 1_000_000 + elapsed,
    )
    expect(decision).toEqual({ kind: 'failed' })
    expect(t.llm.requests).toHaveLength(1)
    expect(t.llm.requests[0].timeoutMs).toBe(DECIDE_CALL_MAX_MS)
  })

  it('shows the picker when the line could mean several Tasks', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    const card = lastReply(t)
    expect(json(card)).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(Object.keys(buttons(card))).toEqual(['ทำสไลด์คู่แข่ง', 'ทำสไลด์ปัญหา', 'ไม่ใช่การอัปเดตงาน'])
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('treats a model answer that would move a Task backwards as noise', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 1, status: 'in_process' }) // already in process
    await t.say(BIW, 'ทำสไลด์อยู่')
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
    await t.press(BIW, b['ยังไม่เสร็จ'])
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.store.tables.task_prompts[0].answer).toBe('no')
    expect(json(lastReply(t))).toContain('ไม่เปลี่ยนสถานะงาน')
  })

  it('Yes on In Process makes the sender the assignee', async () => {
    const t = setup()
    t.answer({ kind: 'match', task: 2, status: 'in_process' })
    await t.say(TON, 'เดี๋ยวเราทำโลโก้เอง')
    await t.press(TON, buttons(lastReply(t))['ใช่ รับงาน'])
    expect(t.task(t.logo.id)).toMatchObject({ status: 'in_process', assigneeLineUserId: TON, doneAt: null })
    expect(json(lastReply(t))).toContain('คนทำ: ต้น')
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
    expect(reply.type).toBe('template')
    if (reply.type !== 'template') throw new Error('not a template')
    const uri = reply.template.actions[0].uri
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
    const wrong = b['ผิดงาน · เลือกงานอื่น']
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
    await t.press(BIW, b['ผิดงาน · เลือกงานอื่น'], 'ev-w1')
    await t.press(BIW, b['ผิดงาน · เลือกงานอื่น'], 'ev-w2')
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
    expect(t.store.tables.task_prompts).toHaveLength(1)

    const t2 = setup()
    const b2 = await askDone(t2)
    await t2.press(BIW, b2['ใช่ เสร็จแล้ว'], 'ev-y')
    await t2.press(BIW, b2['ผิดงาน · เลือกงานอื่น'], 'ev-w')
    expect(json(lastReply(t2))).toContain('มีคนตอบไปแล้ว')
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

  it('a second press says the card was already answered', async () => {
    const t = setup()
    const b = await askDone(t)
    await t.press(BIW, b['ใช่ เสร็จแล้ว'])
    await t.press(BIW, b['ยังไม่เสร็จ'])
    expect(json(lastReply(t))).toContain('มีคนตอบไปแล้ว')
    expect(t.task(t.slides.id).status).toBe('done')
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
    await t.press(BIW, b['ผิดงาน · เลือกงานอื่น'])
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
    expect(json(lastReply(t))).toContain('มีคนตอบไปแล้ว')
  })

  it('"ไม่ใช่การอัปเดตงาน" changes nothing', async () => {
    const t = setup()
    t.answer({ kind: 'ambiguous', tasks: [1, 3], status: 'done' })
    await t.say(TON, 'สไลด์เสร็จแล้วนะ')
    await t.press(TON, buttons(lastReply(t))['ไม่ใช่การอัปเดตงาน'])
    expect(json(lastReply(t))).toContain('ไม่ใช่การอัปเดตงาน')
    expect(t.task(t.slides.id).status).toBe('in_process')
    expect(t.task(t.problem.id).status).toBe('in_process')
  })

  it('ignores postbacks of other features', async () => {
    const t = setup()
    await t.press(BIW, 'a=assign&t=x')
    expect(t.line.replies).toHaveLength(0)
  })
})

describe('noise', () => {
  it('gets no reply', async () => {
    const t = setup()
    t.answer({ kind: 'none' })
    await t.say(BIW, 'ใครว่างไปกินข้าวบ้าง')
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.task_prompts).toHaveLength(0)
  })

  it('skips bot commands, a turned-off feature and groups with no open Tasks, without an AI call', async () => {
    const t = setup()
    await t.say(BIW, 'NongJoDII done')
    t.store.tables.groups[0].featureTrackRemind = false
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    t.store.tables.groups[0].featureTrackRemind = true
    for (const task of t.store.tables.tasks) task.status = 'done'
    await t.say(BIW, 'สไลด์เสร็จแล้ว')
    expect(t.llm.requests).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
  })
})

describe('when the decision model fails', () => {
  it('falls back to the text model; the failed call is not charged', async () => {
    const t = setup()
    t.llm.fail(new Error('503'))
    t.answer({ kind: 'match', task: 1, status: 'done' })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.llm.requests.map((r) => r.model)).toEqual([DECISION_MODEL, TEXT_MODEL])
    expect(json(lastReply(t))).toContain('อัปเดตงานนี้ไหม?')
    expect(t.store.tables.ai_usage).toHaveLength(1)
  })

  it('falls back to the text model when the decision model answers junk', async () => {
    const t = setup()
    t.llm.respond({ content: 'sorry, I cannot', model: TEXT_MODEL, usage: USAGE })
    t.answer({ kind: 'none' })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.llm.requests).toHaveLength(2)
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(2)
  })

  it('asks the group which Task when both models fail on a progress-looking line, keeping the message', async () => {
    const t = setup()
    t.llm.fail(new Error('503'))
    t.llm.fail(new Error('timeout'))
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    const picker = buttons(lastReply(t))
    expect(Object.keys(picker)[0]).toBe('ทำสไลด์คู่แข่ง') // the sender's own Task first
    expect(t.store.tables.messages).toHaveLength(1)

    await t.press(BIW, picker['ทำสไลด์คู่แข่ง'])
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('stays silent when both models fail on ordinary chat', async () => {
    const t = setup()
    t.llm.fail(new Error('503'))
    t.llm.fail(new Error('timeout'))
    await t.say(BIW, 'ใครว่างไปกินข้าวบ้าง')
    expect(t.line.replies).toHaveLength(0)
    expect(t.store.tables.messages).toHaveLength(1)
  })
})

describe('without AI', () => {
  it('at the Fair-use cap, uses the free keyword check and makes no model call', async () => {
    const t = setup()
    t.store.seedAiUsage({ ownerLineUserId: OWNER, groupId: t.group.id, inputTokens: 6_000_000, costUsd: 0.5 })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.llm.requests).toHaveLength(0)
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
  })

  it('in a group without a confirmed Owner, uses the free keyword check', async () => {
    const t = setup({ owned: false })
    await t.say(BIW, 'สไลด์คู่แข่งเสร็จละ')
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.ai_usage).toHaveLength(0)
    expect(json(lastReply(t))).toContain('อัปเดตนี้หมายถึงงานไหน?')
  })
})
