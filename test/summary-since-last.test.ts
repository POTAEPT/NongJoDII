import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent } from '@/server/line/types'
import type { LlmRequest, LlmUsage } from '@/server/ports'
import {
  REPLY_NOTHING_NEW, SUMMARY_CONTEXT_LIMIT, SUMMARY_DONE_DAYS,
} from '@/server/summary/run-summary'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { messagesText } from './flex-text'
import { refOf } from './fakes/prompt-reader'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #108: a second Summary covered the whole chat again and proposed Tasks the group had
// already created and closed. A Summary now covers only the chat since the group's last
// Summary, sends up to SUMMARY_CONTEXT_LIMIT earlier messages as context only (no message
// refs, so no task can come from them), and lists the group's open and recently done
// Tasks so the model does not propose them again.

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const DAY = 86_400_000
const USAGE: LlmUsage = { inputTokens: 1200, outputTokens: 300, costUsd: null }
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  const answer = (tasks: { title: string; source?: string }[]) => {
    h.llm.respond((req: LlmRequest) => ({
      content: JSON.stringify({
        summary: `{${refOf(req, 'Pim Sirin')}} คุยเรื่องงาน`,
        tasks: tasks.map((t) => ({ title: t.title, details: null, assignee: null, due: null, source: t.source ?? null })),
      }),
      model: TEXT_MODEL, usage: USAGE,
    }))
  }
  const say = (text: string, at: number, userId = 'Ubank') => send(ev.groupText({ text, userId, timestamp: at }))
  const command = (at: number, replyToken = `rt-${at}`) =>
    send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken, timestamp: at }))
  return { ...h, group, send, answer, say, command }
}

/** The lines of one prompt section (after its header, up to the next header or the end). */
function section(user: string, header: string): string[] {
  const lines = user.split('\n')
  const start = lines.findIndex((l) => l.startsWith(header))
  if (start === -1) return []
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (/^[A-Z][^:]*:$|^[A-Z][^(]*\(.*\):$/.test(l)) break
    out.push(l)
  }
  return out
}
/** The Summary calls only (a chat line can also start a progress check while Tasks are open). */
const summaryCalls = (t: { llm: { requests: LlmRequest[] } }) => t.llm.requests.filter((r) => r.system.includes('"summary": string'))
const CHAT = 'Chat (oldest first'
const EARLIER = 'Earlier chat'
const EXISTING = 'Existing tasks'

describe('Summary since the last one (#108)', () => {
  it('the first Summary of a group covers the chat as before, with no earlier chat and no existing Tasks', async () => {
    const t = setup()
    await t.say('ใครทำสไลด์ได้บ้าง', T0)
    await t.say('เดี๋ยวทำสไลด์เอง', T0 + MIN, 'Upim')
    t.answer([{ title: 'ทำสไลด์', source: 'msg2' }])
    await t.command(T0 + 10 * MIN)
    const user = t.llm.requests[0].user
    expect(section(user, CHAT)).toHaveLength(2)
    expect(user).not.toContain(EARLIER)
    expect(user).not.toContain(EXISTING)
    expect(t.store.tables.summaries).toHaveLength(1)
  })

  it('a second Summary takes tasks only from the new chat, sees the old chat as context, and is told the Tasks that exist', async () => {
    const t = setup()
    await t.say('ใครทำสไลด์ได้บ้าง', T0)
    await t.say('เดี๋ยวทำสไลด์เอง', T0 + MIN, 'Upim')
    t.answer([{ title: 'ทำสไลด์', source: 'msg2' }])
    await t.command(T0 + 10 * MIN)
    await t.say('พรุ่งนี้ต้องส่งรายงานด้วยนะ', T0 + 60 * MIN)
    // The Task was created and closed, and another is open (seeded after the chat line, so
    // that line starts no progress check).
    const done = t.store.seedTask({ groupId: t.group.id, title: 'ทำสไลด์', createdByLineUserId: 'Upim', status: 'done', assigneeLineUserId: 'Upim' })
    t.store.tables.tasks.find((x) => x.id === done.id)!.doneAt = new Date(T0 + 30 * MIN)
    t.store.seedTask({ groupId: t.group.id, title: 'จองห้อง', createdByLineUserId: 'Upim' })
    t.answer([{ title: 'ส่งรายงาน', source: 'msg1' }])
    await t.command(T0 + 70 * MIN)

    const user = summaryCalls(t)[1].user
    // Only the new line is the chat, with the only message ref.
    const chat = section(user, CHAT)
    expect(chat).toHaveLength(1)
    expect(chat[0]).toMatch(/^msg1 .*พรุ่งนี้ต้องส่งรายงานด้วยนะ$/)
    // The old lines are context, with no message refs.
    const earlier = section(user, EARLIER)
    expect(earlier.map((l) => l.replace(/^\[[^\]]*\] m\d+: /, ''))).toEqual(['ใครทำสไลด์ได้บ้าง', 'เดี๋ยวทำสไลด์เอง'])
    expect(earlier.join('\n')).not.toMatch(/\bmsg\d+\b/)
    // The open and the done Task are listed, newest first.
    expect(section(user, EXISTING)).toEqual(['- [no assignee] จองห้อง', '- [done] ทำสไลด์'])
    // The rules name both sections.
    expect(summaryCalls(t)[1].system).toContain('never take a task from it')
    expect(summaryCalls(t)[1].system).toContain('Existing tasks')
    expect(t.store.tables.task_candidates.map((c) => c.title)).toEqual(['ทำสไลด์', 'ส่งรายงาน'])
  })

  it('with no new chat since the last Summary it says so, with no AI call and no Summary', async () => {
    const t = setup()
    await t.say('ใครทำสไลด์ได้บ้าง', T0)
    t.answer([{ title: 'ทำสไลด์' }])
    await t.command(T0 + 10 * MIN)
    await t.command(T0 + 11 * MIN, 'rt-again')
    expect(t.llm.requests).toHaveLength(1)
    expect(t.store.tables.summaries).toHaveLength(1)
    const again = t.line.replies.find((r) => r.replyToken === 'rt-again')!
    expect(messagesText(again.messages)).toBe(REPLY_NOTHING_NEW)
  })

  it(`sends at most ${SUMMARY_CONTEXT_LIMIT} earlier messages as context, the latest ones`, async () => {
    const t = setup()
    for (let i = 0; i < SUMMARY_CONTEXT_LIMIT + 5; i++) await t.say(`เก่า ${i}`, T0 + i * MIN)
    t.answer([])
    await t.command(T0 + 40 * MIN)
    await t.say('ใหม่', T0 + 50 * MIN)
    t.answer([])
    await t.command(T0 + 60 * MIN)
    const earlier = section(summaryCalls(t)[1].user, EARLIER)
    expect(earlier).toHaveLength(SUMMARY_CONTEXT_LIMIT)
    expect(earlier[0]).toContain('เก่า 5')
    expect(earlier.at(-1)).toContain(`เก่า ${SUMMARY_CONTEXT_LIMIT + 4}`)
  })

  it(`lists open Tasks and Tasks done in the last ${SUMMARY_DONE_DAYS} days, not older or deleted ones`, async () => {
    const t = setup()
    const now = T0 + 10 * MIN
    const seed = (title: string, status: 'done' | 'in_process', doneDaysAgo: number | null, deleted = false) => {
      const row = t.store.seedTask({ groupId: t.group.id, title, createdByLineUserId: 'Upim', status })
      const rec = t.store.tables.tasks.find((x) => x.id === row.id)!
      if (doneDaysAgo !== null) rec.doneAt = new Date(now - doneDaysAgo * DAY)
      if (deleted) rec.deletedAt = new Date(now)
    }
    await t.say('คุยต่อ', T0)
    seed('งานเก่ามาก', 'done', SUMMARY_DONE_DAYS + 1)
    seed('เพิ่งเสร็จ', 'done', 2)
    seed('กำลังทำอยู่', 'in_process', null)
    seed('ลบแล้ว', 'in_process', null, true)
    t.answer([])
    await t.command(now)
    expect(section(summaryCalls(t)[0].user, EXISTING)).toEqual(['- [in progress] กำลังทำอยู่', '- [done] เพิ่งเสร็จ'])
  })
})
