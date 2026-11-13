import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { answerProgressFromLiff } from '@/server/progress/liff'
import { ANSWER_TEXT, PICK_MAX } from '@/server/reminders/answer'
import { REMINDER_TEXT, reminderCarousel } from '@/server/reminders/card'
import { encodeReminderAction } from '@/server/reminders/postback'
import { selectReminders } from '@/server/reminders/select'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, webhookBody } from './harness'

// #45 (8c) through the event seam: reminder button presses and typed fallbacks go in as
// signed webhooks; replies and Task rows come out. Bangkok wall-clock times; "now" is
// Monday 16 Nov 2026, 09:05, just after the daily reminder.

const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const TON = 'Uton'
const bkk = (s: string) => new Date(`${s}+07:00`)
const NOW = bkk('2026-11-16T09:05:00')

function setup() {
  const h = makeTestDeps({ now: NOW })
  const group = seedOwnedGroup(h.store, {
    members: [{ lineUserId: BIW, displayName: 'บิว' }, { lineUserId: TON, displayName: 'ต้น' }],
  })
  const base = { groupId: group.id, createdByLineUserId: OWNER }
  const slides = h.store.seedTask({ ...base, title: 'ทำสไลด์', status: 'in_process', assigneeLineUserId: BIW, dueAt: bkk('2026-11-16T17:00:00') })
  const room = h.store.seedTask({ ...base, title: 'จองห้อง' }) // no owner
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const press = (userId: string | null, data: string, pickedDate?: string) =>
    send(ev.groupPostback({ data, userId, replyToken: 'rt-press', pickedDate }))
  const say = (userId: string, text: string) => send(ev.groupText({ text, userId, replyToken: 'rt-say' }))
  const task = (id: string) => h.store.tables.tasks.find((t) => t.id === id)!
  const lastReply = () => h.line.replies.at(-1)!.messages[0]
  return { ...h, group, slides, room, send, press, say, task, lastReply }
}

const json = (m: LineMessage) => JSON.stringify(m)
const textOf = (m: LineMessage) => (m.type === 'text' ? m.text : m.altText)

/** Every button action of a Flex message, by label. */
function buttons(m: LineMessage): Record<string, { type: string; data: string; min?: string; initial?: string }> {
  const out: Record<string, { type: string; data: string; min?: string; initial?: string }> = {}
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const a = n.action as { type: string; label: string; data: string } | undefined
    if (n.type === 'button' && a) out[a.label] = a
    for (const v of Object.values(n)) walk(v)
  }
  if (m.type === 'flex') walk(m.contents)
  return out
}

const done = (taskId: string) => encodeReminderAction({ kind: 'done', taskId })
const postpone = (taskId: string) => encodeReminderAction({ kind: 'postpone', taskId })
const take = (taskId: string) => encodeReminderAction({ kind: 'take', taskId })

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reminder card buttons (#45, option ก)', () => {
  it('gives an owned Task Postpone and Done, and a Task with no owner only "ฉันรับเอง"', () => {
    const t = setup()
    const tasks = [t.slides, t.room].map((r) => ({ ...r, lastActivityAt: NOW }))
    const { items, total } = selectReminders(tasks, NOW)
    const card = reminderCarousel({ items, total, names: new Map(), now: NOW })
    if (card.type !== 'flex') throw new Error('expected a Flex carousel')
    const bubbles = (card.contents as { contents: unknown[] }).contents
    expect(Object.keys(buttons({ type: 'flex', altText: '', contents: bubbles[1] as Record<string, unknown> }))).toEqual([REMINDER_TEXT.postpone, REMINDER_TEXT.done])
    expect(Object.keys(buttons({ type: 'flex', altText: '', contents: bubbles[2] as Record<string, unknown> }))).toEqual([REMINDER_TEXT.take])
  })
})

describe('Done (#45)', () => {
  it('the owner marks the Task Done, with a reply and no push', async () => {
    const t = setup()
    await t.press(BIW, done(t.slides.id))
    expect(t.task(t.slides.id)).toMatchObject({ status: 'done', doneAt: NOW, lastActivityAt: NOW, lastEditedByLineUserId: BIW })
    expect(textOf(t.lastReply())).toBe('“ทำสไลด์” เสร็จแล้ว')
    expect(t.line.replies[0].replyToken).toBe('rt-press')
    expect(t.line.pushes).toHaveLength(0)
  })

  it('someone else is told who may answer, and nothing changes', async () => {
    const t = setup()
    await t.press(TON, done(t.slides.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.notAllowed('บิว'))
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('a second press on a Done Task changes nothing', async () => {
    const t = setup()
    await t.press(BIW, done(t.slides.id))
    await t.press(BIW, done(t.slides.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(t.slides.id).doneAt).toEqual(NOW)
  })

  it('a Task with no owner asks someone to take it first', async () => {
    const t = setup()
    await t.press(BIW, done(t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.noOwner)
    expect(t.task(t.room.id).status).toBe('not_assigned')
  })

  it('a Task from another group is not touched', async () => {
    const t = setup()
    await t.send(ev.groupPostback({ data: done(t.slides.id), userId: BIW, groupId: 'Cother', replyToken: 'rt-x' }))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.gone)
    expect(t.task(t.slides.id).status).toBe('in_process')
  })
})

describe('Postpone (#45)', () => {
  it('replies with +1 day, +3 days, +1 week from today and a date picker', async () => {
    const t = setup()
    await t.press(BIW, postpone(t.slides.id))
    const b = buttons(t.lastReply())
    expect(Object.keys(b)).toEqual(['+1 วัน (อ. 17 พ.ย.)', '+3 วัน (พฤ. 19 พ.ย.)', '+1 สัปดาห์ (จ. 23 พ.ย.)', ANSWER_TEXT.pickDate])
    expect(b[ANSWER_TEXT.pickDate]).toMatchObject({ type: 'datetimepicker', min: '2026-11-16', initial: '2026-11-17' })
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-16T17:00:00')) // nothing changes yet
  })

  it('a choice moves the due date and keeps the time of day', async () => {
    const t = setup()
    await t.press(BIW, postpone(t.slides.id))
    await t.press(BIW, buttons(t.lastReply())['+3 วัน (พฤ. 19 พ.ย.)'].data)
    expect(t.task(t.slides.id)).toMatchObject({ dueAt: bkk('2026-11-19T17:00:00'), lastActivityAt: NOW, lastEditedByLineUserId: BIW })
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.postponed('ทำสไลด์', 'พฤ. 19 พ.ย. 17:00'))
  })

  it('the date picker sets the chosen date', async () => {
    const t = setup()
    await t.press(BIW, postpone(t.slides.id))
    await t.press(BIW, buttons(t.lastReply())[ANSWER_TEXT.pickDate].data, '2026-11-30')
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-30T17:00:00'))
  })

  it('refuses a date in the past', async () => {
    const t = setup()
    await t.press(BIW, encodeReminderAction({ kind: 'postpone_pick', taskId: t.slides.id }), '2026-11-15')
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.pastDate)
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-16T17:00:00'))
  })

  it('a Task with no due time gets 18:00', async () => {
    const t = setup()
    t.task(t.slides.id).dueAt = null
    await t.press(BIW, encodeReminderAction({ kind: 'postpone_to', taskId: t.slides.id, date: '2026-11-17' }))
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-17T18:00:00'))
  })

  it('a Task reassigned between the check and the write is not answered by the former owner', async () => {
    const t = setup()
    const stale = (await t.store.getTask(t.slides.id))! // the copy the resolver read: still BIW's
    t.task(t.slides.id).assigneeLineUserId = TON // the edit page reassigned it meanwhile
    vi.spyOn(t.store, 'getTask').mockResolvedValueOnce(stale)
    await t.press(BIW, done(t.slides.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.notAllowed('ต้น'))
    expect(t.task(t.slides.id).status).toBe('in_process')

    vi.spyOn(t.store, 'getTask').mockResolvedValueOnce(stale)
    await t.press(BIW, encodeReminderAction({ kind: 'postpone_to', taskId: t.slides.id, date: '2026-11-17' }))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.notAllowed('ต้น'))
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-16T17:00:00'))
  })

  it('only the owner may postpone', async () => {
    const t = setup()
    await t.press(TON, encodeReminderAction({ kind: 'postpone_to', taskId: t.slides.id, date: '2026-11-17' }))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.notAllowed('บิว'))
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-16T17:00:00'))
  })
})

describe('ฉันรับเอง (#45, option ก)', () => {
  it('the presser becomes the owner and the Task moves to In Process', async () => {
    const t = setup()
    await t.press(TON, take(t.room.id))
    expect(t.task(t.room.id)).toMatchObject({ assigneeLineUserId: TON, status: 'in_process', lastActivityAt: NOW })
    expect(textOf(t.lastReply())).toBe('“จองห้อง” กำลังทำ')
  })

  it('a second person is told it is already taken', async () => {
    const t = setup()
    await t.press(TON, take(t.room.id))
    await t.press(BIW, take(t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.alreadyTaken('ต้น'))
    expect(t.task(t.room.id).assigneeLineUserId).toBe(TON)
  })

  it('a first-time presser is registered as a Member, so the Task stays editable', async () => {
    const t = setup()
    await t.press('Unew', take(t.room.id))
    expect(t.task(t.room.id).assigneeLineUserId).toBe('Unew')
    expect(await t.store.getMembership(t.group.id, 'Unew')).toBe('live')
  })

  it('a Member who left the group cannot take it', async () => {
    const t = setup()
    t.store.tables.group_members.find((m) => m.lineUserId === TON)!.leftAt = bkk('2026-11-15T10:00:00')
    await t.press(TON, take(t.room.id))
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.left)
    expect(t.task(t.room.id).assigneeLineUserId).toBeNull()
  })
})

describe('a press without the presser\'s userId (#45)', () => {
  it('opens LIFF instead of answering blindly, and changes nothing', async () => {
    const t = setup()
    await t.press(null, done(t.slides.id))
    const reply = t.lastReply()
    expect(reply.type).toBe('template')
    expect(json(reply)).toContain(`https://liff.line.me/${TEST_LIFF_ID}?view=progress&id=${encodeURIComponent(done(t.slides.id))}`)
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('a date-picker press goes back to the choices, as its date cannot ride along', async () => {
    const t = setup()
    await t.press(null, encodeReminderAction({ kind: 'postpone_pick', taskId: t.slides.id }), '2026-11-30')
    expect(json(t.lastReply())).toContain(encodeURIComponent(postpone(t.slides.id)))
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-16T17:00:00'))
  })

  it('the LIFF page answers after LINE login, for the owner only', async () => {
    const t = setup()
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
    t.line.idTokens.set('tok-ton', { lineUserId: TON, displayName: 'ต้น' })
    const refused = await answerProgressFromLiff(t.deps, { idToken: 'tok-ton', data: done(t.slides.id) })
    expect(refused.body).toMatchObject({ result: 'not_allowed' })
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: done(t.slides.id) })
    expect(res).toMatchObject({ status: 200, body: { result: 'done', text: '“ทำสไลด์” เสร็จแล้ว' } })
    expect(t.task(t.slides.id).status).toBe('done')
  })

  it('the LIFF page shows the postpone choices as buttons', async () => {
    const t = setup()
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: postpone(t.slides.id) })
    const body = res.body as { result: string; choices: { label: string }[] }
    expect(body.result).toBe('asked_date')
    expect(body.choices.map((c) => c.label)).toEqual(['+1 วัน (อ. 17 พ.ย.)', '+3 วัน (พฤ. 19 พ.ย.)', '+1 สัปดาห์ (จ. 23 พ.ย.)'])
  })

  it('the LIFF page offers its own date input, which postpones to the picked date', async () => {
    const t = setup()
    t.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
    const asked = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: postpone(t.slides.id) })
    const pick = (asked.body as { datePick: { label: string; data: string; min: string; initial: string } }).datePick
    expect(pick).toEqual({
      label: ANSWER_TEXT.pickDate, data: encodeReminderAction({ kind: 'postpone_pick', taskId: t.slides.id }),
      min: '2026-11-16', initial: '2026-11-17',
    })
    const past = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: pick.data, pickedDate: '2026-11-10' })
    expect(past.body).toMatchObject({ result: 'past_date' })
    const res = await answerProgressFromLiff(t.deps, { idToken: 'tok-biw', data: pick.data, pickedDate: '2026-11-30' })
    expect(res.body).toMatchObject({ result: 'postponed' })
    expect(t.task(t.slides.id).dueAt).toEqual(bkk('2026-11-30T17:00:00'))
  })

  it('the LIFF page refuses an outsider', async () => {
    const t = setup()
    t.line.idTokens.set('tok-out', { lineUserId: 'Uoutsider', displayName: 'X' })
    expect((await answerProgressFromLiff(t.deps, { idToken: 'tok-out', data: done(t.slides.id) })).status).toBe(403)
  })
})

describe('typed fallbacks (#45)', () => {
  it('"NongJoDII done" with one open Task marks it Done', async () => {
    const t = setup()
    await t.say(BIW, 'NongJoDII done')
    expect(t.task(t.slides.id).status).toBe('done')
    expect(t.line.replies[0].replyToken).toBe('rt-say')
  })

  it('"NongJoDII need time" with one open Task replies with the postpone choices', async () => {
    const t = setup()
    await t.say(BIW, 'NongJoDII need time')
    expect(Object.keys(buttons(t.lastReply()))).toContain('+1 วัน (อ. 17 พ.ย.)')
  })

  it('with several open Tasks, asks which one', async () => {
    const t = setup()
    const logo = t.store.seedTask({ groupId: t.group.id, title: 'ทำโลโก้', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: BIW })
    await t.say(BIW, 'NongJoDII done')
    const b = buttons(t.lastReply())
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.pickDone)
    expect(Object.keys(b)).toEqual(['ทำสไลด์', 'ทำโลโก้'])
    await t.press(BIW, b['ทำโลโก้'].data)
    expect(t.task(logo.id).status).toBe('done')
    expect(t.task(t.slides.id).status).toBe('in_process')
  })

  it('with more Tasks than the picker holds, shows the nearest due first and says how many are left', async () => {
    const t = setup()
    for (let i = 0; i < PICK_MAX + 1; i += 1) {
      // Created before slides would not matter: the order is by due date, and these are all later.
      t.store.seedTask({
        groupId: t.group.id, title: `งาน ${i}`, createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: BIW,
        dueAt: i === 0 ? null : bkk(`2026-11-${String(17 + i).padStart(2, '0')}T12:00:00`),
      })
    }
    await t.say(BIW, 'NongJoDII done')
    const labels = Object.keys(buttons(t.lastReply()))
    expect(labels).toHaveLength(PICK_MAX)
    expect(labels[0]).toBe('ทำสไลด์') // due today
    expect(labels).not.toContain('งาน 0') // no due date: last
    expect(json(t.lastReply())).toContain(ANSWER_TEXT.moreTasks(2))
  })

  it('with no open Task of the sender, says so', async () => {
    const t = setup()
    await t.say(TON, 'NongJoDII done')
    expect(textOf(t.lastReply())).toBe(ANSWER_TEXT.noOpenTasks)
  })

  it('makes no AI call', async () => {
    const t = setup()
    await t.say(BIW, 'NongJoDII need time')
    await t.say(BIW, 'NongJoDII done')
    expect(t.llm.requests).toHaveLength(0)
  })
})
