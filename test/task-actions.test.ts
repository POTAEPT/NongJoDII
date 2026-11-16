import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { ANSWER_TEXT } from '@/server/reminders/answer'
import { encodeReminderAction } from '@/server/reminders/postback'
import { buildTaskFeedbackCard } from '@/server/review/feedback'
import { TASK_ACTION_TEXT } from '@/server/tasks/card'
import { updateTaskFromLiff } from '@/server/tasks/update'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { buttonActions, messageText } from './flex-text'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, webhookBody } from './harness'

// #23 through the event seam: the unowned Task's buttons on the "สร้างงานแล้ว" card
// (มอบหมาย, ฉันรับเอง, ไม่ใช่งาน), the delete confirm, its decline, and undo. Presses go in as
// signed webhooks; replies and Task rows come out. Edit is covered in task-edit.test.ts.

const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const TON = 'Uton'

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, {
    members: [{ lineUserId: BIW, displayName: 'บิว' }, { lineUserId: TON, displayName: 'ต้น' }],
  })
  const room = h.store.seedTask({ groupId: group.id, title: 'จองห้อง', createdByLineUserId: OWNER }) // no owner
  const slides = h.store.seedTask({
    groupId: group.id, title: 'ทำสไลด์', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: BIW,
  })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const press = (userId: string | null, data: string) => send(ev.groupPostback({ data, userId, replyToken: 'rt-press' }))
  const task = (id: string) => h.store.tables.tasks.find((t) => t.id === id)!
  const lastReply = () => h.line.replies.at(-1)!.messages[0]
  return { ...h, group, room, slides, send, press, task, lastReply }
}

const act = (kind: 'take' | 'discard' | 'discard_yes' | 'discard_no' | 'restore', taskId: string) =>
  encodeReminderAction({ kind, taskId })
const textOf = (m: LineMessage) => (m.type === 'text' ? m.text : m.altText)
const labels = (m: LineMessage) => (m.type === 'flex' ? buttonActions(m.contents).map((a) => a.label) : [])
const dataOf = (m: LineMessage, label: string) => {
  const a = m.type === 'flex' ? buttonActions(m.contents).find((b) => b.label === label) : undefined
  if (!a || a.type !== 'postback' || !a.data) throw new Error(`no postback button ${label}`)
  return a.data
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the "สร้างงานแล้ว" card (#23)', () => {
  const card = () => buildTaskFeedbackCard([
    { taskId: '00000000-0000-4000-8000-000000000001', title: 'จองห้อง', assigned: false, assigneeName: null, dueAt: null },
    { taskId: '00000000-0000-4000-8000-000000000002', title: 'ทำสไลด์', assigned: true, assigneeName: 'บิว', dueAt: null },
  ], TEST_LIFF_ID)

  it('gives an unowned Task มอบหมาย, ฉันรับเอง and ไม่ใช่งาน, and an owned one only แก้งาน', () => {
    const m = card()
    if (m.type !== 'flex') throw new Error('expected Flex')
    const [unowned, owned] = (m.contents as { contents: Record<string, unknown>[] }).contents
    expect(buttonActions(unowned)).toEqual([
      { type: 'uri', label: 'มอบหมาย', uri: `https://liff.line.me/${TEST_LIFF_ID}?view=task&id=00000000-0000-4000-8000-000000000001` },
      { type: 'postback', label: 'ฉันรับเอง', data: act('take', '00000000-0000-4000-8000-000000000001'), displayText: 'ฉันรับเอง' },
      { type: 'postback', label: 'ไม่ใช่งาน', data: act('discard', '00000000-0000-4000-8000-000000000001'), displayText: 'ไม่ใช่งาน' },
    ])
    expect(buttonActions(owned).map((a) => a.label)).toEqual(['แก้งาน'])
  })

  it('keeps every postback within 300 characters and every label within 20', () => {
    const m = card()
    if (m.type !== 'flex') throw new Error('expected Flex')
    for (const a of buttonActions(m.contents)) {
      expect([...a.label].length).toBeLessThanOrEqual(20)
      if (a.type === 'postback') expect(a.data?.length ?? 0).toBeLessThanOrEqual(300)
    }
  })
})

describe('มอบหมาย (#23)', () => {
  it('sets the chosen Member as the owner from the LIFF Task page', async () => {
    const t = setup()
    t.line.idTokens.set('tok-ton', { lineUserId: TON, displayName: 'ต้น' })
    const res = await updateTaskFromLiff(t.deps, {
      idToken: 'tok-ton', taskId: t.room.id, title: 'จองห้อง', details: null, assigneeLineUserId: BIW, dueAt: null,
    })
    expect(res.status).toBe(200)
    expect(t.task(t.room.id)).toMatchObject({ assigneeLineUserId: BIW, status: 'in_process' })
  })
})

describe('ฉันรับเอง (#23)', () => {
  it('makes the presser from the event\'s user ID the owner', async () => {
    const t = setup()
    await t.press(TON, act('take', t.room.id))
    expect(t.task(t.room.id)).toMatchObject({ assigneeLineUserId: TON, status: 'in_process' })
  })

  it('without a user ID opens LIFF, and LINE login makes that person the owner', async () => {
    const t = setup()
    await t.press(null, act('take', t.room.id))
    expect(t.lastReply().type).toBe('flex')
    expect(JSON.stringify(t.lastReply())).toContain(encodeURIComponent(act('take', t.room.id)))
    expect(t.task(t.room.id).assigneeLineUserId).toBeNull()
    t.line.idTokens.set('tok-ton', { lineUserId: TON, displayName: 'ต้น' })
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-ton', data: act('take', t.room.id) })
    expect(res.body).toMatchObject({ result: 'taken' })
    expect(t.task(t.room.id)).toMatchObject({ assigneeLineUserId: TON, status: 'in_process' })
  })
})

describe('ไม่ใช่งาน (#23)', () => {
  it('asks for a confirm first and changes nothing', async () => {
    const t = setup()
    await t.press(TON, act('discard', t.room.id))
    const reply = t.lastReply()
    expect(messageText(reply)).toContain(TASK_ACTION_TEXT.confirmTitle)
    expect(labels(reply)).toEqual([TASK_ACTION_TEXT.confirmNo, TASK_ACTION_TEXT.confirmYes])
    expect(t.task(t.room.id).deletedAt).toBeNull()
    expect(t.line.pushes).toHaveLength(0)
  })

  it('"ลบงาน" on the confirm deletes the Task, and it leaves the open Task list', async () => {
    const t = setup()
    await t.press(TON, act('discard', t.room.id))
    await t.press(TON, dataOf(t.lastReply(), TASK_ACTION_TEXT.confirmYes))
    expect(textOf(t.lastReply())).toBe(TASK_ACTION_TEXT.deleted('จองห้อง'))
    expect(labels(t.lastReply())).toEqual([TASK_ACTION_TEXT.restore])
    expect(t.task(t.room.id)).toMatchObject({ deletedAt: t.deps.now(), deletedByLineUserId: TON })
    expect((await t.store.listOpenTasks(t.group.id)).map((r) => r.id)).not.toContain(t.room.id)
  })

  it('"ไม่ลบ" on the confirm changes nothing', async () => {
    const t = setup()
    await t.press(TON, act('discard', t.room.id))
    await t.press(TON, dataOf(t.lastReply(), TASK_ACTION_TEXT.confirmNo))
    expect(textOf(t.lastReply())).toBe(TASK_ACTION_TEXT.kept('จองห้อง'))
    expect(t.task(t.room.id).deletedAt).toBeNull()
  })

  it('a Task someone has taken is not deleted', async () => {
    const t = setup()
    await t.press(TON, act('discard', t.room.id))
    const yes = dataOf(t.lastReply(), TASK_ACTION_TEXT.confirmYes)
    await t.press(BIW, act('take', t.room.id))
    await t.press(TON, yes)
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.alreadyTaken('บิว'))
    expect(t.task(t.room.id)).toMatchObject({ deletedAt: null, assigneeLineUserId: BIW })
    await t.press(TON, act('discard', t.slides.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.alreadyTaken('บิว'))
  })

  it('a second "ลบงาน" on a deleted Task changes nothing', async () => {
    const t = setup()
    await t.press(TON, act('discard_yes', t.room.id))
    const at = t.task(t.room.id).deletedAt
    await t.press(BIW, act('discard_yes', t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(t.room.id)).toMatchObject({ deletedAt: at, deletedByLineUserId: TON })
  })

  it('a Member who left cannot delete', async () => {
    const t = setup()
    await t.store.markMemberLeft({ groupId: t.group.id, lineUserId: TON, at: t.deps.now() })
    await t.press(TON, act('discard_yes', t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.left)
    expect(t.task(t.room.id).deletedAt).toBeNull()
  })

  it('a Task from another group is not touched', async () => {
    const t = setup()
    const other = seedOwnedGroup(t.store, { lineGroupId: 'Cother' })
    const far = t.store.seedTask({ groupId: other.id, title: 'งานกลุ่มอื่น', createdByLineUserId: OWNER })
    await t.press(TON, act('discard_yes', far.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(far.id).deletedAt).toBeNull()
  })

  it('without a user ID opens LIFF, and the confirm works there after LINE login', async () => {
    const t = setup()
    await t.press(null, act('discard', t.room.id))
    expect(t.lastReply().type).toBe('flex')
    expect(t.task(t.room.id).deletedAt).toBeNull()
    t.line.idTokens.set('tok-ton', { lineUserId: TON, displayName: 'ต้น' })
    const asked = await answerProgressFromLiff(t.deps, { idToken: 'tok-ton', data: act('discard', t.room.id) })
    const choices = (asked.body as { result: string; choices: { label: string; data: string }[] })
    expect(choices.result).toBe('confirm_discard')
    expect(choices.choices.map((c) => c.label)).toEqual([TASK_ACTION_TEXT.confirmNo, TASK_ACTION_TEXT.confirmYes])
    const yes = choices.choices.find((c) => c.label === TASK_ACTION_TEXT.confirmYes)!
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-ton', data: yes.data })
    expect(res.body).toMatchObject({ result: 'deleted', choices: [{ label: TASK_ACTION_TEXT.restore }] })
    expect(t.task(t.room.id).deletedByLineUserId).toBe(TON)
  })
})

describe('กู้คืน (#23)', () => {
  it('restores the deleted Task, unowned again, with its buttons back', async () => {
    const t = setup()
    await t.press(TON, act('discard_yes', t.room.id))
    await t.press(BIW, dataOf(t.lastReply(), TASK_ACTION_TEXT.restore))
    expect(textOf(t.lastReply())).toBe(TASK_ACTION_TEXT.restored('จองห้อง'))
    expect(labels(t.lastReply())).toEqual(['มอบหมาย', 'ฉันรับเอง', 'ไม่ใช่งาน'])
    expect(t.task(t.room.id)).toMatchObject({ deletedAt: null, deletedByLineUserId: null, status: 'not_assigned', assigneeLineUserId: null })
    expect((await t.store.listOpenTasks(t.group.id)).map((r) => r.id)).toContain(t.room.id)
  })

  it('a second "กู้คืน" changes nothing', async () => {
    const t = setup()
    await t.press(TON, act('discard_yes', t.room.id))
    await t.press(TON, act('restore', t.room.id))
    await t.press(TON, act('restore', t.room.id))
    expect(textOf(t.lastReply())).toBe(TASK_ACTION_TEXT.notDeleted)
  })

  it('does not bring back a Task removed some other way (no deleted_by)', async () => {
    const t = setup()
    t.task(t.room.id).deletedAt = t.deps.now()
    await t.press(TON, act('restore', t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(t.room.id).deletedAt).not.toBeNull()
  })

  it('a Task from another group is not restored', async () => {
    const t = setup()
    const other = seedOwnedGroup(t.store, { lineGroupId: 'Cother' })
    const far = t.store.seedTask({ groupId: other.id, title: 'งานกลุ่มอื่น', createdByLineUserId: OWNER })
    await t.store.deleteTask({ taskId: far.id, by: OWNER, at: t.deps.now() })
    await t.press(TON, act('restore', far.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(far.id).deletedAt).not.toBeNull()
  })
})
