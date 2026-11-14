import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { retryKeyFrom } from '@/server/line/push-budget'
import { MEMBER_LEFT_MAX_TASKS, MEMBER_LEFT_TEXT } from '@/server/members/card'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { ANSWER_TEXT } from '@/server/reminders/answer'
import { encodeReminderAction } from '@/server/reminders/postback'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { TEST_LIFF_ID, ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #29 (leave part) through the event seam: a signed memberLeft webhook goes in; Task rows,
// the membership row and one group push come out. LINE's quota in the fake is 300 a month.

const BIW = 'Ubiw'
const TON = 'Uton'
const OWNER = 'Uowner1'

function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  const group = seedOwnedGroup(h.store, {
    members: [{ lineUserId: BIW, displayName: 'บิว' }, { lineUserId: TON, displayName: 'ต้น' }],
  })
  h.line.groupMemberCounts.set('Cgroup1', 3)
  const base = { groupId: group.id, createdByLineUserId: OWNER }
  const slides = h.store.seedTask({ ...base, title: 'ทำสไลด์', status: 'in_process', assigneeLineUserId: BIW, dueAt: new Date('2026-11-20T10:00:00Z') })
  const poster = h.store.seedTask({ ...base, title: 'ทำโปสเตอร์', status: 'in_process', assigneeLineUserId: BIW })
  const logo = h.store.seedTask({ ...base, title: 'ทำโลโก้', status: 'done', assigneeLineUserId: BIW })
  const budget = h.store.seedTask({ ...base, title: 'ทำงบ', status: 'in_process', assigneeLineUserId: TON })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const task = (id: string) => h.store.tables.tasks.find((t) => t.id === id)!
  return { ...h, group, slides, poster, logo, budget, send, task }
}

/** Every text in a Flex tree. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  return [...(o.type === 'text' && typeof o.text === 'string' ? [o.text] : []), ...Object.values(o).flatMap(texts)]
}

/** Every button action, in order. */
function actions(m: LineMessage): { type: string; label: string; data?: string; uri?: string }[] {
  const out: { type: string; label: string; data?: string; uri?: string }[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n.type === 'button' && n.action) out.push(n.action as { type: string; label: string })
    Object.values(n).forEach(walk)
  }
  if (m.type === 'flex') walk(m.contents)
  return out
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a member leaves the group (#29)', () => {
  it('their open Tasks go back to Not Assigned; Done Tasks and other people\'s keep their owner', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
    expect(t.task(t.poster.id)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
    expect(t.task(t.logo.id)).toMatchObject({ assigneeLineUserId: BIW, status: 'done' })
    expect(t.task(t.budget.id)).toMatchObject({ assigneeLineUserId: TON, status: 'in_process' })
  })

  it('posts one card listing those Tasks, each with Assign and "ฉันรับเอง", as one push', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW], eventId: 'ev-left-1' }))
    expect(t.line.delivered).toHaveLength(1)
    const { to, messages, retryKey } = t.line.delivered[0]
    expect(to).toBe('Cgroup1')
    expect(messages).toHaveLength(1)
    expect(retryKey).toBe(retryKeyFrom('member_left:ev-left-1'))
    const card = messages[0]
    expect(texts(card.type === 'flex' ? card.contents : null)).toEqual(expect.arrayContaining([
      MEMBER_LEFT_TEXT.title(['บิว']), MEMBER_LEFT_TEXT.body(2), 'ทำสไลด์', 'ทำโปสเตอร์',
    ]))
    expect(texts(card.type === 'flex' ? card.contents : null)).not.toContain('ทำโลโก้')
    expect(actions(card)).toEqual([
      { type: 'uri', label: MEMBER_LEFT_TEXT.assign, uri: `https://liff.line.me/${TEST_LIFF_ID}?view=task&id=${t.slides.id}` },
      { type: 'postback', label: MEMBER_LEFT_TEXT.take, data: encodeReminderAction({ kind: 'take', taskId: t.slides.id }), displayText: MEMBER_LEFT_TEXT.take },
      { type: 'uri', label: MEMBER_LEFT_TEXT.assign, uri: `https://liff.line.me/${TEST_LIFF_ID}?view=task&id=${t.poster.id}` },
      { type: 'postback', label: MEMBER_LEFT_TEXT.take, data: encodeReminderAction({ kind: 'take', taskId: t.poster.id }), displayText: MEMBER_LEFT_TEXT.take },
    ])
    expect(t.store.tables.push_log).toMatchObject([{ purpose: 'member_left', lineTargetId: 'Cgroup1', messageCount: 3 }])
  })

  it('"ฉันรับเอง" on the card gives the Task to whoever presses it', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    await t.send(ev.groupPostback({ userId: TON, data: encodeReminderAction({ kind: 'take', taskId: t.slides.id }) }))
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: TON, status: 'in_process' })
  })

  it('marks the person as left: no more LIFF access to the group, and they cannot take Tasks back', async () => {
    const t = setup()
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(await t.store.getMembership(t.group.id, BIW)).toBe('left')
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: encodeReminderAction({ kind: 'take', taskId: t.slides.id }) })
    expect(res.status).toBe(403)
    await t.send(ev.groupPostback({ userId: BIW, data: encodeReminderAction({ kind: 'take', taskId: t.slides.id }), replyToken: 'rt-biw' }))
    expect(t.line.replies.at(-1)!.messages[0]).toEqual({ type: 'text', text: ANSWER_TEXT.left })
    expect(t.task(t.slides.id).assigneeLineUserId).toBeNull()
  })

  it('a person with only Done Tasks is marked left and nothing is posted', async () => {
    const t = setup()
    t.task(t.slides.id).status = 'done'
    t.task(t.poster.id).status = 'done'
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(await t.store.getMembership(t.group.id, BIW)).toBe('left')
    expect(t.line.pushes).toHaveLength(0)
    expect(t.task(t.slides.id).assigneeLineUserId).toBe(BIW)
  })

  it('a leave delivered twice posts one card', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW], eventId: 'ev-dup' }))
    await t.send(ev.memberLeft({ userIds: [BIW], eventId: 'ev-dup', redelivery: true }))
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a second leave event for the same person finds nothing to post', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(t.line.pushes).toHaveLength(1)
  })

  it('several people leaving in one event share one card', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW, TON] }))
    expect(t.line.pushes).toHaveLength(1)
    const card = t.line.pushes[0].messages[0]
    expect(texts(card.type === 'flex' ? card.contents : null)).toEqual(expect.arrayContaining([
      MEMBER_LEFT_TEXT.title(['บิว', 'ต้น']), MEMBER_LEFT_TEXT.body(3),
    ]))
  })

  it(`lists at most ${MEMBER_LEFT_MAX_TASKS} Tasks and says how many more there are`, async () => {
    const t = setup()
    for (let i = 0; i < MEMBER_LEFT_MAX_TASKS; i += 1) {
      t.store.seedTask({ groupId: t.group.id, createdByLineUserId: OWNER, title: `งาน ${i}`, status: 'in_process', assigneeLineUserId: BIW })
    }
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    const card = t.line.pushes[0].messages[0]
    expect(card.type === 'flex' && (card.contents.contents as unknown[]).length).toBe(12) // LINE's carousel limit
    expect(texts(card.type === 'flex' ? card.contents : null)).toContain(MEMBER_LEFT_TEXT.more(2))
    expect(t.store.tables.tasks.filter((x) => x.status === 'not_assigned')).toHaveLength(MEMBER_LEFT_MAX_TASKS + 2)
  })

  it('near the quota the card is skipped, and the Tasks are still released', async () => {
    const t = setup()
    t.line.quota = { limit: 300, used: 268 } // 268 + 3 people = 271 > 270 (10% reserve)
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(t.line.pushes).toHaveLength(0)
    expect(t.task(t.slides.id).status).toBe('not_assigned')
  })

  it('a failed save answers 500 and is not recorded, so LINE\'s redelivery completes the leave', async () => {
    const t = setup()
    t.store.failNext('markMemberLeft')
    const body = webhookBody(ev.memberLeft({ userIds: [BIW], eventId: 'ev-left-fail' }))
    expect((await handleWebhookRequest(signedRequest(body), t.deps, t.defer)).status).toBe(500)
    await t.runDeferred()
    expect(await t.store.getMembership(t.group.id, BIW)).toBe('live')
    expect(t.line.pushes).toHaveLength(0)

    await t.send(ev.memberLeft({ userIds: [BIW], eventId: 'ev-left-fail', redelivery: true }))
    expect(await t.store.getMembership(t.group.id, BIW)).toBe('left')
    expect(t.task(t.slides.id).status).toBe('not_assigned')
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a message that arrives after the leave does not add the person back', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: ['Unew'] })) // never seen in the group before
    await t.send(ev.groupText({ userId: 'Unew', text: 'ข้อความก่อนออก' }))
    expect(await t.store.getMembership(t.group.id, 'Unew')).toBe('left')
    expect(t.line.pushes).toHaveLength(0)
  })

  it('makes no AI call', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    expect(t.llm.requests).toHaveLength(0)
  })
})
