import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { AdapterError } from '@/server/log'
import type { LlmRequest, LlmUsage } from '@/server/ports'
import { runSummaryCommand } from '@/server/summary/run-summary'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, webhookBody } from './harness'

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const USAGE: LlmUsage = { inputTokens: 1200, outputTokens: 300, costUsd: null }
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม', 'Pim'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

type Refs = (lineName: string) => string

/** The member ref the prompt gave to the person with this LINE name. */
function refOf(user: string, lineName: string): string {
  const m = new RegExp(`^(m\\d+): LINE name "${lineName.replace(/[.]/g, '\\.')}"`, 'm').exec(user)
  if (!m) throw new Error(`no ref for ${lineName}`)
  return m[1]
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup(opts?: { lineGroupId?: string }) {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { lineGroupId: opts?.lineGroupId, members: MEMBERS })
  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  /** Queues a model answer built from the refs in the request's prompt. */
  const respond = (build: (ref: Refs) => unknown, usage: LlmUsage = USAGE) => {
    h.llm.respond((req: LlmRequest) => ({
      content: JSON.stringify(build((name) => refOf(req.user, name))), model: TEXT_MODEL, usage,
    }))
  }
  const command = (text = 'NongJoDII summarize', p?: { replyToken?: string; groupId?: string; timestamp?: number }) =>
    send(ev.groupText({
      text, userId: 'Upim', groupId: p?.groupId, replyToken: p?.replyToken ?? 'rt-cmd', timestamp: p?.timestamp ?? T0 + 10 * MIN,
    }))
  return { ...h, group, send, respond, command }
}

async function seedChat(t: ReturnType<typeof setup>) {
  await t.send(
    ev.groupText({ text: 'สวัสดีทุกคน', userId: 'Upim', timestamp: T0 }),
    ev.groupText({ text: 'ใครทำสไลด์ได้บ้าง\nด่วนนะ', userId: 'Ubank', timestamp: T0 + MIN }),
    ev.groupText({ text: 'เดี๋ยวทำสไลด์เอง', userId: 'Upim', timestamp: T0 + 2 * MIN }),
  )
}

const standardAnswer = (ref: Refs) => ({
  summary: `{${ref('Pim Sirin')}} จะทำสไลด์ ส่วน {${ref('Bank T.')}} ดูเรื่องห้อง`,
  tasks: [
    { title: 'ทำสไลด์', details: `{${ref('Pim Sirin')}} ทำ 10 หน้า`, assignee: ref('Pim Sirin'), due: '2026-11-20T17:00:00+07:00', source: '#2' },
    { title: 'จองห้อง', assignee: null },
  ],
})

function textOf(messages: LineMessage[]): string {
  const m = messages[0]
  if (m.type !== 'text') throw new Error('first message is not text')
  return m.text
}

describe('Summary command', () => {
  it.each(['NongJoDII summarize', 'NongJoDII สรุปหน่อย'])('1. %j triggers one reply and one AI call', async (phrase) => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command(phrase, { replyToken: 'rt-phrase' })
    expect(t.llm.requests).toHaveLength(1)
    expect(t.line.replies).toHaveLength(1)
    expect(t.line.replies[0].replyToken).toBe('rt-phrase')
  })

  it('2. a non-command text makes no AI call and no reply', async () => {
    const t = setup()
    await seedChat(t)
    await t.send(ev.groupText({ text: 'summarize it', userId: 'Upim', timestamp: T0 + 5 * MIN }))
    expect(t.llm.requests).toHaveLength(0)
    expect(t.line.replies).toHaveLength(0)
  })

  it('3. reads the last messages with sender and Bangkok time, without the command', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    const { user } = t.llm.requests[0]
    const mP = refOf(user, 'Pim Sirin')
    const mB = refOf(user, 'Bank T.')
    expect(user).toContain(`#1 [2026-11-12 09:00] ${mP}: สวัสดีทุกคน`)
    expect(user).toContain(`#2 [2026-11-12 09:01] ${mB}: ใครทำสไลด์ได้บ้าง ด่วนนะ`)
    expect(user).toContain(`#3 [2026-11-12 09:02] ${mP}: เดี๋ยวทำสไลด์เอง`)
    expect(user).not.toContain('NongJoDII')
    expect(t.llm.requests[0].system).toContain('Today is 2026-11-12 (Asia/Bangkok)')
  })

  it('4. sends only the newest 100 texts (M1)', async () => {
    const t = setup()
    const events = Array.from({ length: 120 }, (_, i) =>
      ev.groupText({ text: `msg-${String(i + 1).padStart(3, '0')}`, userId: 'Ubank', timestamp: T0 + i * 1000 }))
    await t.send(...events)
    t.respond(() => ({ summary: 'สรุป', tasks: [] }))
    await t.command()
    const { user } = t.llm.requests[0]
    expect(user).toContain('msg-021')
    expect(user).toContain('msg-120')
    expect(user).not.toContain('msg-020')
    expect(user).not.toContain('NongJoDII')
    expect(user.match(/^#\d+ \[/gm)).toHaveLength(100)
  })

  it('5. the reply uses LINE names, never refs or nicknames (H1)', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    const text = textOf(t.line.replies[0].messages)
    expect(text).toContain('Pim Sirin จะทำสไลด์ ส่วน Bank T. ดูเรื่องห้อง')
    expect(text).toContain('ผู้รับ: Pim Sirin · กำหนด: 20 พ.ย. 17:00')
    expect(text).toContain('ยังไม่มีผู้รับ · กำหนด: ไม่ระบุ')
    expect(text).toContain('จาก Bank T. เวลา 12 พ.ย. 09:01')
    expect(text).toContain('งานที่พบ (2)')
    expect(text).not.toContain('{m')
    expect(text).not.toContain('พิม')
    expect(text).not.toContain('แบงค์')
    expect(t.store.tables.task_candidates[0].details).toBe('Pim Sirin ทำ 10 หน้า')
    expect(t.store.tables.summaries[0].summaryText).toBe('Pim Sirin จะทำสไลด์ ส่วน Bank T. ดูเรื่องห้อง')
  })

  it('5b. a raw nickname from a disobeying model is left as is', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(() => ({ summary: 'สรุป', tasks: [{ title: 'พิมทำสไลด์' }] }))
    await t.command()
    expect(t.store.tables.task_candidates[0].title).toBe('พิมทำสไลด์')
    expect(textOf(t.line.replies[0].messages)).toContain('พิมทำสไลด์')
  })

  it('5c. an assignee without a LINE name shows สมาชิก (L1)', async () => {
    const t = setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Unoname', displayName: 'x' })
    const row = t.store.tables.line_users.find((u) => u.lineUserId === 'Unoname')
    if (row) row.displayName = null
    await seedChat(t)
    t.respond((ref) => ({ summary: 'สรุป', tasks: [{ title: 'ทำงาน', assignee: ref('unknown') }] }))
    await t.command()
    const text = textOf(t.line.replies[0].messages)
    expect(text).toContain('ผู้รับ: สมาชิก')
    expect(text).not.toContain('ยังไม่มีผู้รับ')
    expect(t.store.tables.task_candidates[0].suggestedAssigneeLineUserId).toBe('Unoname')
  })

  it('6. nicknames go to the AI', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    expect(t.llm.requests[0].user).toContain('nicknames: พิม, Pim')
    expect(t.llm.requests[0].user).toContain('พิม')
  })

  it('7. the button opens the LIFF confirm form for this Summary', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    const msgs = t.line.replies[0].messages
    expect(msgs).toHaveLength(2)
    const button = msgs[1]
    if (button.type !== 'template') throw new Error('second message is not a template')
    expect(button.altText).toBe('สรุปแชท: พบ 2 งาน')
    expect(button.template.text).toBe('พบ 2 งาน กดเพื่อเลือก แก้ไข และยืนยันก่อนสร้างงาน')
    expect(button.template.actions[0].label).toBe('ตรวจและยืนยันงาน')
    expect(button.template.actions[0].uri).toBe(
      `https://liff.line.me/${TEST_LIFF_ID}?view=review&id=${t.store.tables.summaries[0].id}`,
    )
  })

  it('8. replies in the group that asked, from that group\'s chat only (M7)', async () => {
    const t = setup()
    const groupB = seedOwnedGroup(t.store, { lineGroupId: 'Cgroup2' })
    await t.send(
      ev.groupText({ text: 'a-text-1', groupId: 'Cgroup1', userId: 'Upim', timestamp: T0 }),
      ev.groupText({ text: 'b-text-1', groupId: 'Cgroup2', userId: 'Uowner1', timestamp: T0 + MIN }),
    )
    t.respond(() => ({ summary: 'สรุป', tasks: [] }))
    await t.send(ev.groupText({ text: 'NongJoDII summarize', groupId: 'Cgroup2', userId: 'Uowner1', replyToken: 'rt-B', timestamp: T0 + 2 * MIN }))
    expect(t.line.replies).toHaveLength(1)
    expect(t.line.replies[0].replyToken).toBe('rt-B')
    expect(t.llm.requests[0].user).toContain('b-text-1')
    expect(t.llm.requests[0].user).not.toContain('a-text-1')
    expect(t.store.tables.summaries[0].groupId).toBe(groupB.id)
  })

  it('9. stores candidates as proposals and creates no Task', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    const rows = t.store.tables.task_candidates
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.state === 'proposed')).toBe(true)
    expect(rows[0]).toMatchObject({
      title: 'ทำสไลด์', suggestedAssigneeLineUserId: 'Upim', suggestedDueAt: new Date('2026-11-20T10:00:00Z'),
    })
    expect(rows[1].suggestedAssigneeLineUserId).toBeNull()
    expect(t.store.tables.tasks).toHaveLength(0)
    expect(t.store.tables.summaries[0]).toMatchObject({
      requestedByLineUserId: 'Upim', firstMessageAt: new Date(T0), lastMessageAt: new Date(T0 + 2 * MIN),
    })
  })

  it('10. a left Member named by the model is not the suggested assignee (L4)', async () => {
    const t = setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Uleft', displayName: 'Left Lee', leftAt: new Date(T0) })
    await seedChat(t)
    await t.send(ev.groupText({ text: 'ฝากด้วยนะ', userId: 'Uleft', timestamp: T0 + 3 * MIN }))
    t.respond((ref) => ({ summary: 'สรุป', tasks: [{ title: 'ทำงาน', assignee: ref('Left Lee') }] }))
    await t.command()
    expect(t.store.tables.task_candidates[0].suggestedAssigneeLineUserId).toBeNull()
    expect(textOf(t.line.replies[0].messages)).toContain('ยังไม่มีผู้รับ')
  })

  it('11. records usage against the Owner', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({
      ownerLineUserId: 'Uowner1', groupId: t.group.id, projectId: t.group.projectId, purpose: 'summary',
      inputTokens: 1200, outputTokens: 300, model: TEXT_MODEL,
    })
    expect(t.llm.requests[0]).toMatchObject({ model: TEXT_MODEL, maxTokens: 4000 })
  })

  it('12. without a confirmed Owner it explains and calls no AI', async () => {
    const t = setup()
    t.store.tables.groups[0].ownerConfirmedAt = null
    await seedChat(t)
    await t.command()
    expect(t.llm.requests).toHaveLength(0)
    expect(textOf(t.line.replies[0].messages)).toBe(
      'กลุ่มนี้ยังไม่มีเจ้าของกลุ่มที่ยืนยันแล้ว จึงยังสรุปแชทไม่ได้ กรุณาตั้งค่ากลุ่มให้เสร็จก่อน',
    )
  })

  it('13. invalid model JSON replies with the error, keeps usage, stores no Summary', async () => {
    const t = setup()
    await seedChat(t)
    t.llm.respond({ content: 'not json', model: TEXT_MODEL, usage: USAGE })
    await t.command()
    expect(textOf(t.line.replies[0].messages)).toBe('ขอโทษนะ ตอนนี้สรุปแชทไม่สำเร็จ ลองใหม่อีกครั้ง')
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.summaries).toHaveLength(0)
  })

  it('14. zero tasks gives one text and no button', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(() => ({ summary: 'คุยกันทั่วไป', tasks: [] }))
    await t.command()
    const msgs = t.line.replies[0].messages
    expect(msgs).toHaveLength(1)
    expect(textOf(msgs)).toBe('สรุปแชทล่าสุด\nคุยกันทั่วไป\n\nไม่พบงานใหม่ในแชทช่วงนี้')
  })

  it('15. with Summary off it explains and calls no AI (L4)', async () => {
    const t = setup()
    t.store.tables.groups[0].featureSummarize = false
    await seedChat(t)
    await t.command()
    expect(textOf(t.line.replies[0].messages)).toBe('ฟีเจอร์สรุปแชทปิดอยู่ในกลุ่มนี้ เปิดได้ที่การตั้งค่า')
    expect(t.llm.requests).toHaveLength(0)
    expect(t.store.tables.summaries).toHaveLength(0)
  })

  it('16. with Draft tasks off it stores the Summary only (M4)', async () => {
    const t = setup()
    t.store.tables.groups[0].featureDraftTasks = false
    await seedChat(t)
    t.respond(standardAnswer)
    await t.command()
    expect(t.store.tables.summaries).toHaveLength(1)
    expect(t.store.tables.task_candidates).toHaveLength(0)
    const msgs = t.line.replies[0].messages
    expect(msgs).toHaveLength(1)
    expect(textOf(msgs)).toBe('สรุปแชทล่าสุด\nPim Sirin จะทำสไลด์ ส่วน Bank T. ดูเรื่องห้อง')
  })

  it('17. a missing group row does nothing (L4)', async () => {
    const t = setup()
    await expect(runSummaryCommand(t.deps, {
      groupId: randomUUID(), lineGroupId: 'Cmissing', replyToken: 'rt-x', requesterLineUserId: null,
    })).resolves.toBeUndefined()
    expect(t.line.replies).toHaveLength(0)
    expect(t.llm.requests).toHaveLength(0)
  })

  it('18. with only the command stored it says there is nothing to summarize (L4)', async () => {
    const t = setup()
    await t.command()
    expect(textOf(t.line.replies[0].messages)).toBe('ยังไม่มีข้อความให้สรุป')
    expect(t.llm.requests).toHaveLength(0)
  })

  it.each([
    ['an AdapterError timeout', new AdapterError('openrouter timeout')],
    ['a raw TimeoutError', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
    ['a SyntaxError from an invalid body', new SyntaxError('Unexpected token')],
  ])('19. %s replies with the error and records nothing (M5)', async (_, err) => {
    const t = setup()
    await seedChat(t)
    t.llm.fail(err)
    await t.command()
    expect(t.line.replies).toHaveLength(1)
    expect(textOf(t.line.replies[0].messages)).toBe('ขอโทษนะ ตอนนี้สรุปแชทไม่สำเร็จ ลองใหม่อีกครั้ง')
    expect(t.store.tables.ai_usage).toHaveLength(0)
    expect(t.store.tables.summaries).toHaveLength(0)
  })

  it('20. a failed reply is logged once and not retried', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    t.line.failReply = true
    await t.command()
    // FakeLine records the attempt before throwing: one attempt, no retry.
    expect(t.line.replies).toHaveLength(1)
    expect(t.store.tables.summaries).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('summary_reply_failed'))
  })
})
