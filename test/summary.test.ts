import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { AdapterError } from '@/server/log'
import type { LlmRequest, LlmUsage } from '@/server/ports'
import { runSummaryCommand } from '@/server/summary/run-summary'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { NAME_WAIT_MS } from '@/server/webhook/process'
import { chatLines, refMentioning, refOf, taggedRefs, todayOf } from './fakes/prompt-reader'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, webhookBody } from './harness'

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const USAGE: LlmUsage = { inputTokens: 1200, outputTokens: 300, costUsd: null }
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม', 'Pim'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

type Refs = (lineName: string) => string

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
  const respond = (build: (ref: Refs, req: LlmRequest) => unknown, usage: LlmUsage = USAGE) => {
    h.llm.respond((req: LlmRequest) => ({
      content: JSON.stringify(build((name) => refOf(req, name), req)), model: TEXT_MODEL, usage,
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

function addDays(isoDate: string | null, days: number): string {
  if (isoDate === null) return 'no-date'
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

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

  it('3. the AI reads the last messages with sender and Bangkok time, without the command, and knows today', async () => {
    const t = setup()
    await seedChat(t)
    // The fake model retells each chat line it read, and dates a task "tomorrow" from its idea of today.
    t.respond((_, req) => ({
      summary: chatLines(req).map((c) => `${c.time} {${c.senderRef}} ${c.text}`).join(' | '),
      tasks: [{ title: 'ทำสไลด์', due: `${addDays(todayOf(req), 1)}T17:00:00+07:00` }],
    }))
    await t.command()
    expect(t.store.tables.summaries[0].summaryText).toBe(
      '09:00 Pim Sirin สวัสดีทุกคน | 09:01 Bank T. ใครทำสไลด์ได้บ้าง ด่วนนะ | 09:02 Pim Sirin เดี๋ยวทำสไลด์เอง',
    )
    expect(t.store.tables.task_candidates[0].suggestedDueAt).toEqual(new Date('2026-11-13T10:00:00Z'))
  })

  it('4. sends only the newest 100 texts (M1)', async () => {
    const t = setup()
    const events = Array.from({ length: 120 }, (_, i) =>
      ev.groupText({ text: `msg-${String(i + 1).padStart(3, '0')}`, userId: 'Ubank', timestamp: T0 + i * 1000 }))
    await t.send(...events)
    // The fake model reports how many messages it read and the first and last.
    t.respond((_, req) => {
      const chat = chatLines(req)
      return { summary: `${chat.length} ${chat[0].text} ${chat[chat.length - 1].text}`, tasks: [] }
    })
    await t.command()
    expect(t.store.tables.summaries[0]).toMatchObject({
      summaryText: '100 msg-021 msg-120', firstMessageAt: new Date(T0 + 20 * 1000), lastMessageAt: new Date(T0 + 119 * 1000),
    })
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

  it('6. the AI can match a nickname in the chat to the Member (rule 9)', async () => {
    const t = setup()
    await seedChat(t)
    await t.send(ev.groupText({ text: 'ฝากแบงค์จองห้องด้วย', userId: 'Upim', timestamp: T0 + 3 * MIN }))
    // The fake model assigns the booking to whichever member the prompt ties to the nickname
    // "แบงค์"; that word is in no LINE name, so only the Member's nickname can tie it.
    t.respond((_, req) => ({
      summary: 'สรุป',
      tasks: chatLines(req).filter((c) => c.text.includes('แบงค์')).map((c) => ({
        title: 'จองห้อง', assignee: refMentioning(req, 'แบงค์'), source: c.ref,
      })),
    }))
    await t.command()
    expect(t.store.tables.task_candidates).toHaveLength(1)
    expect(t.store.tables.task_candidates[0].suggestedAssigneeLineUserId).toBe('Ubank')
    expect(textOf(t.line.replies[0].messages)).toContain('ผู้รับ: Bank T.')
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
    // The fake model retells every chat text it read.
    t.respond((_, req) => ({ summary: chatLines(req).map((c) => c.text).join(' | '), tasks: [] }))
    await t.send(ev.groupText({ text: 'NongJoDII summarize', groupId: 'Cgroup2', userId: 'Uowner1', replyToken: 'rt-B', timestamp: T0 + 2 * MIN }))
    expect(t.line.replies).toHaveLength(1)
    expect(t.line.replies[0].replyToken).toBe('rt-B')
    expect(t.store.tables.summaries[0]).toMatchObject({ groupId: groupB.id, summaryText: 'b-text-1' })
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

  it('11b. a usage write that keeps failing still delivers the Summary and keeps the estimate as the charge', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(standardAnswer)
    for (let i = 0; i < 5; i++) t.store.failNext('settleAiUsage')
    await t.command()
    expect(t.line.replies).toHaveLength(1)
    expect(textOf(t.line.replies[0].messages)).toContain('สรุปแชทล่าสุด')
    expect(t.store.tables.summaries).toHaveLength(1)
    expect(t.store.tables.ai_usage).toHaveLength(1)
    // The open estimate row stays: output counted at the full maxTokens, not the reported 300.
    expect(t.store.tables.ai_usage[0]).toMatchObject({ ownerLineUserId: 'Uowner1', outputTokens: 4000, settledAt: null })
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

describe('Summary with tagged Members (@mention)', () => {
  // Two live Members share the LINE name "Pim"; Bank tags one of them.
  const TWINS = [
    { lineUserId: 'Upim1', displayName: 'Pim' },
    { lineUserId: 'Upim2', displayName: 'Pim' },
    { lineUserId: 'Ubank', displayName: 'Bank T.' },
  ]

  function twinSetup() {
    const h = makeTestDeps()
    seedOwnedGroup(h.store, { members: TWINS })
    const send = async (...events: LineEvent[]) => {
      const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
      expect(res.status).toBe(200)
      await h.runDeferred()
    }
    return { ...h, send }
  }

  it.each(['Upim1', 'Upim2'])('the tagged person (%s) is the suggested assignee, not a namesake', async (tagged) => {
    const t = twinSetup()
    await t.send(ev.groupText({
      text: '@Pim ช่วยทำสไลด์หน่อย', userId: 'Ubank', timestamp: T0,
      mentionees: [{ index: 0, length: 4, type: 'user', userId: tagged }],
    }))
    // The fake model takes the person tagged in the slides message; with no tag it falls
    // back to the first member named "Pim", as a model guessing from names would.
    t.llm.respond((req: LlmRequest) => {
      const line = chatLines(req).find((c) => c.text.includes('สไลด์'))
      const assignee = (line && taggedRefs(line.text)[0]) ?? refMentioning(req, '"Pim"')
      return {
        content: JSON.stringify({ summary: 'สรุป', tasks: [{ title: 'ทำสไลด์', assignee, source: line?.ref ?? null }] }),
        model: TEXT_MODEL, usage: USAGE,
      }
    })
    await t.send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Ubank', timestamp: T0 + MIN }))
    expect(t.store.tables.task_candidates).toHaveLength(1)
    expect(t.store.tables.task_candidates[0].suggestedAssigneeLineUserId).toBe(tagged)
    // The reply still shows the LINE name, never a ref.
    const text = textOf(t.line.replies[0].messages)
    expect(text).toContain('ผู้รับ: Pim')
    expect(text).not.toContain('{m')
  })
})

describe('Summary commands in one webhook', () => {
  /** A model call that finishes only once `count` calls are running at the same time,
   *  and fails after 300 ms otherwise (jobs run one after another). */
  function barrier(count: number) {
    let started = 0
    let release!: () => void
    const all = new Promise<void>((resolve) => { release = resolve })
    return async () => {
      started += 1
      if (started === count) release()
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AdapterError('openrouter timeout')), 300)
      })
      try {
        await Promise.race([all, timeout])
      } finally {
        clearTimeout(timer)
      }
    }
  }

  it('two slow Summaries run together and both reply', async () => {
    const t = setup()
    await seedChat(t)
    const wait = barrier(2)
    for (let i = 0; i < 2; i++) {
      t.llm.respond(async () => {
        await wait()
        return { content: JSON.stringify({ summary: 'คุยกันทั่วไป', tasks: [] }), model: TEXT_MODEL, usage: USAGE }
      })
    }
    await t.send(
      ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-1', timestamp: T0 + 10 * MIN }),
      ev.groupText({ text: 'NongJoDII สรุปหน่อย', userId: 'Ubank', replyToken: 'rt-2', timestamp: T0 + 11 * MIN }),
    )
    expect(t.line.replies.map((r) => r.replyToken).sort()).toEqual(['rt-1', 'rt-2'])
    for (const r of t.line.replies) expect(textOf(r.messages)).toContain('คุยกันทั่วไป')
    expect(t.store.tables.summaries).toHaveLength(2)
  })

  it('a failing Summary does not hold up or stop the other', async () => {
    const t = setup()
    await seedChat(t)
    const wait = barrier(2)
    // FIFO queue: which command draws which answer depends on timing, so assert on the set.
    t.llm.respond(async () => {
      await wait()
      throw new AdapterError('openrouter 500')
    })
    t.llm.respond(async () => {
      await wait()
      return { content: JSON.stringify({ summary: 'คุยกันทั่วไป', tasks: [] }), model: TEXT_MODEL, usage: USAGE }
    })
    await t.send(
      ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-1', timestamp: T0 + 10 * MIN }),
      ev.groupText({ text: 'NongJoDII summarize', userId: 'Ubank', replyToken: 'rt-2', timestamp: T0 + 11 * MIN }),
    )
    expect(t.line.replies).toHaveLength(2)
    expect(t.line.replies.map((r) => textOf(r.messages)).sort()).toEqual([
      'ขอโทษนะ ตอนนี้สรุปแชทไม่สำเร็จ ลองใหม่อีกครั้ง',
      'สรุปแชทล่าสุด\nคุยกันทั่วไป\n\nไม่พบงานใหม่ในแชทช่วงนี้',
    ])
    expect(t.store.tables.summaries).toHaveLength(1)
  })

  it('a slow name lookup holds a Summary back at most NAME_WAIT_MS and never holds other jobs', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(() => ({ summary: 'คุยกันทั่วไป', tasks: [] }))
    // A sender the bot has never seen needs a LINE profile call, which is slow here.
    t.line.slowProfileMs = NAME_WAIT_MS + 1_000
    const order: string[] = []
    const reply = t.line.reply.bind(t.line)
    t.line.reply = async (replyToken, messages) => {
      order.push(`reply ${replyToken}`)
      return reply(replyToken, messages)
    }
    const profile = t.line.getGroupMemberProfile.bind(t.line)
    t.line.getGroupMemberProfile = async (g, u) => {
      try {
        return await profile(g, u)
      } finally {
        order.push('profile settled')
      }
    }
    await t.send(
      ev.groupText({ text: 'มีใครว่างบ้าง', userId: 'Unewcomer', timestamp: T0 + 9 * MIN }),
      ev.follow({ userId: 'Ufriend' }),
      ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-1', timestamp: T0 + 10 * MIN }),
    )
    // Both replies go out before the slow lookup ends; the batch still waits for it.
    expect(order).toHaveLength(3)
    expect(order.slice(0, 2).filter((e) => e.startsWith('reply '))).toHaveLength(2)
    expect(order.slice(0, 2)).toContain('reply rt-1')
    expect(order[2]).toBe('profile settled')
    expect(t.store.tables.summaries).toHaveLength(1)
  }, 10_000)

  it('a job that throws is logged and the other job still runs', async () => {
    const t = setup()
    await seedChat(t)
    t.respond(() => ({ summary: 'คุยกันทั่วไป', tasks: [] }))
    // Every reply fails: the Summary logs its own failure, the 1:1 card's reply throws out of its job.
    t.line.failReply = true
    await t.send(
      ev.follow({ userId: 'Ufriend' }),
      ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-1', timestamp: T0 + 10 * MIN }),
    )
    expect(t.line.replies).toHaveLength(2)
    expect(t.store.tables.summaries).toHaveLength(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('webhook_job_failed'))
  })
})
