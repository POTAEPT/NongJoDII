import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import type { LlmRequest } from '@/server/ports'
import { loadReview } from '@/server/review/load'
import { submitReview } from '@/server/review/submit'
import type { ReviewView, SubmitResult } from '@/server/review/types'
import { formatThaiShort } from '@/server/time/bangkok'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { chatLines, refMentioning, refOf } from './fakes/prompt-reader'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #5 acceptance: every checkbox, driven through signed webhooks and the review seam.

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const USAGE = { inputTokens: 1234, outputTokens: 321, costUsd: null }
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม', 'Pim'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
  { lineUserId: 'Ucarol', displayName: 'Carol K.', nicknames: ['แครอล'] },
]
const OWNER = 'Uowner1'
const REQUESTER = 'Ubank'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function textOf(messages: LineMessage[]): string {
  const m = messages[0]
  if (m.type !== 'text') throw new Error('first message is not text')
  return m.text
}

type Answer = { summary: string; tasks: Record<string, unknown>[] }

async function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  for (const [tok, id, name] of [['tok-pim', 'Upim', 'Pim Sirin'], ['tok-bank', 'Ubank', 'Bank T.'], ['tok-owner', OWNER, 'Owner']]) {
    h.line.idTokens.set(tok, { lineUserId: id, displayName: name })
  }
  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  await send(
    ev.groupText({ text: 'ให้พิมทำสไลด์', userId: REQUESTER, timestamp: T0 + MIN }),
    ev.groupText({ text: 'โอเค', userId: 'Upim', timestamp: T0 + 2 * MIN }),
  )
  const respond = (build: (ref: (lineName: string) => string, req: LlmRequest) => Answer) => {
    h.llm.respond((req: LlmRequest) => ({
      content: JSON.stringify(build((name) => refOf(req, name), req)), model: TEXT_MODEL, usage: USAGE,
    }))
  }
  /** The Pim-slides answer the model gives under the H1 rule: people only as {mP}. */
  const slides = (ref: (lineName: string) => string): Answer => slidesFor(ref('Pim Sirin'))
  const slidesFor = (mP: string | null): Answer => {
    return {
      summary: `{${mP}} รับทำสไลด์`,
      tasks: [
        { title: 'ทำสไลด์', details: `{${mP}} ทำ 10 หน้า`, assignee: mP, due: '2026-11-20T17:00:00+07:00', source: 's1' },
        { title: 'จองห้อง', assignee: null },
        { title: 'ซื้อของ', assignee: null },
      ],
    }
  }
  let minute = 10
  const command = async (text = 'NongJoDII summarize') => {
    minute += 1
    await send(ev.groupText({ text, userId: REQUESTER, timestamp: T0 + minute * MIN }))
  }
  /** One Summary from the webhook; returns its id and candidate ids. */
  const summarize = async (build: Parameters<typeof respond>[0] = slides) => {
    respond(build)
    await command()
    const s = h.store.tables.summaries[h.store.tables.summaries.length - 1]
    const cands = h.store.tables.task_candidates.filter((c) => c.summaryId === s.id).map((c) => c.id)
    return { summaryId: s.id, cands }
  }
  const candidate = (id: string) => h.store.tables.task_candidates.find((c) => c.id === id)!
  const confirm = (candidateId: string, p: Record<string, unknown> = {}) => ({
    candidateId, action: 'confirm', title: 'ทำสไลด์', details: null, assigneeLineUserId: 'Upim', dueAt: null, ...p,
  })
  const decline = (candidateId: string) => ({ candidateId, action: 'decline' })
  const submit = (summaryId: string, decisions: unknown[], idToken = 'tok-pim') =>
    submitReview(h.deps, { idToken, summaryId, decisions })
  return { ...h, group, send, respond, slides, slidesFor, command, summarize, candidate, confirm, decline, submit }
}

const results = (body: unknown) => (body as SubmitResult).results

describe('#5.1 both phrases trigger the Summary', () => {
  it('NongJoDII summarize, then NongJoDII สรุปหน่อย: two summaries and two replies', async () => {
    const t = await setup()
    t.respond(t.slides)
    await t.command('NongJoDII summarize')
    t.respond(t.slides)
    await t.command('NongJoDII สรุปหน่อย')
    expect(t.store.tables.summaries).toHaveLength(2)
    expect(t.llm.requests).toHaveLength(2)
    // FakeLine.replies also records failed replies; none fail here.
    expect(t.line.failReply).toBe(false)
    expect(t.line.replies).toHaveLength(2)
    expect(t.line.replies[0].replyToken).not.toBe(t.line.replies[1].replyToken)
    for (const r of t.line.replies) expect(textOf(r.messages)).toContain('Pim Sirin รับทำสไลด์')
    expect(t.store.tables.tasks).toHaveLength(0)
  })
})

describe('#5.2 candidates carry sender and time context', () => {
  it('the reply shows จาก <LINE name> เวลา <time> for a candidate with a seeded source', async () => {
    const t = await setup()
    await t.summarize()
    const text = textOf(t.line.replies[0].messages)
    const sentAt = new Date(T0 + MIN)
    expect(text).toContain(`จาก Bank T. เวลา ${formatThaiShort(sentAt)}`)
    expect(text).toContain('จาก Bank T. เวลา 12 พ.ย. 09:01')
    // Only the first candidate has a source; the other two lines carry no จาก.
    expect(text.match(/จาก/g)).toHaveLength(1)
    const noSource = text.split('\n').filter((l) => /^\d+\. (จองห้อง|ซื้อของ)/.test(l))
    expect(noSource).toHaveLength(2)
    expect(noSource.every((l) => !l.includes('จาก'))).toBe(true)
  })
})

describe('#5.3 nicknames match people, screens show LINE names', () => {
  it('the AI ties the nickname in the chat to the Member; reply, candidates and review show only the LINE name', async () => {
    const t = await setup()
    // The chat says "ให้พิมทำสไลด์". The fake model gives the slides to the member the
    // prompt ties to "พิม", a word in no LINE name, so only the nickname can tie it.
    const { summaryId, cands: [c1] } = await t.summarize((_, req) => {
      const asked = chatLines(req).some((c) => c.text.includes('พิม'))
      return t.slidesFor(asked ? refMentioning(req, 'พิม') : null)
    })
    expect(t.candidate(c1).suggestedAssigneeLineUserId).toBe('Upim')

    const text = t.line.replies[0].messages
      .map((m) => (m.type === 'text' ? m.text : JSON.stringify(m)))
      .join('\n')
    expect(text).toContain('Pim Sirin รับทำสไลด์')
    expect(text).toContain('ผู้รับ: Pim Sirin')
    expect(text).not.toContain('พิม')
    expect(text).not.toContain('{m')

    const res = await loadReview(t.deps, { idToken: 'tok-pim', summaryId })
    expect(res.status).toBe(200)
    const view = res.body as ReviewView
    expect(view.candidates[0].details).toBe('Pim Sirin ทำ 10 หน้า')
    expect(view.candidates[0].suggestedAssigneeLineUserId).toBe('Upim')
    expect(view.members.find((m) => m.lineUserId === 'Upim')?.displayName).toBe('Pim Sirin')
    const json = JSON.stringify({ view, text })
    expect(json).not.toContain('พิม')
    expect(json).not.toContain('{m')
    for (const m of view.members) {
      expect(m.displayName).not.toContain('พิม')
      expect(m.displayName).not.toContain('{m')
    }
  })
})

describe('#5.4 the form allows several at once', () => {
  it('one submit with confirm, confirm edited and decline gives 2 tasks', async () => {
    const t = await setup()
    const { summaryId, cands: [c1, c2, c3] } = await t.summarize()
    const res = await t.submit(summaryId, [
      t.confirm(c1),
      t.confirm(c2, { title: 'จองห้องประชุม', assigneeLineUserId: 'Ucarol' }),
      t.decline(c3),
    ])
    expect(res.status).toBe(200)
    expect(results(res.body).map((r) => r.outcome)).toEqual(['created', 'created', 'declined'])
    expect(t.store.tables.tasks).toHaveLength(2)
    expect(t.candidate(c3).state).toBe('declined')
    expect(t.store.tables.tasks.find((x) => x.candidateId === c2)).toMatchObject({
      title: 'จองห้องประชุม', assigneeLineUserId: 'Ucarol',
    })
    expect(t.store.tables.tasks.find((x) => x.candidateId === c1)).toMatchObject({ title: 'ทำสไลด์', assigneeLineUserId: 'Upim' })
  })
})

describe('#5.5 a Task is created only after confirm', () => {
  it('zero tasks after the Summary and after load, then N after submit', async () => {
    const t = await setup()
    const { summaryId, cands: [c1, c2] } = await t.summarize()
    expect(t.store.tables.tasks).toHaveLength(0)
    await loadReview(t.deps, { idToken: 'tok-pim', summaryId })
    expect(t.store.tables.tasks).toHaveLength(0)
    expect(t.store.tables.task_candidates.every((c) => c.state === 'proposed')).toBe(true)
    await t.submit(summaryId, [t.confirm(c1), t.confirm(c2, { title: 'จองห้อง', assigneeLineUserId: null })])
    expect(t.store.tables.tasks).toHaveLength(2)
  })
})

describe('#5.6 tagged person is the owner, otherwise Not Assigned', () => {
  it('both variants', async () => {
    const t = await setup()
    const { summaryId, cands: [c1, c2] } = await t.summarize()
    await t.submit(summaryId, [t.confirm(c1, { assigneeLineUserId: 'Upim' }), t.confirm(c2, { title: 'จองห้อง', assigneeLineUserId: null })])
    const task = (id: string) => t.store.tables.tasks.find((x) => x.candidateId === id)!
    expect(task(c1)).toMatchObject({ assigneeLineUserId: 'Upim', status: 'in_process' })
    expect(task(c2)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
  })
})

describe('#5.7 creator is recorded', () => {
  it('createdBy is the confirmer, who is neither the requester nor the Owner', async () => {
    const t = await setup()
    const { summaryId, cands: [c1] } = await t.summarize()
    // Pim confirms: not the requester (Bank), not the Owner, and not the assignee here.
    await t.submit(summaryId, [t.confirm(c1, { assigneeLineUserId: 'Ucarol' })], 'tok-pim')
    const [task] = t.store.tables.tasks
    expect(t.store.tables.summaries[0].requestedByLineUserId).toBe(REQUESTER)
    expect(task.createdByLineUserId).toBe('Upim')
    expect(task.createdByLineUserId).not.toBe(REQUESTER)
    expect(task.createdByLineUserId).not.toBe(OWNER)
    expect(task.assigneeLineUserId).toBe('Ucarol')
    expect(t.candidate(c1).decidedByLineUserId).toBe('Upim')
  })
})

describe('#5.8 token counts are saved to the Owner usage', () => {
  it('the ai_usage row belongs to the group Owner, not the requester', async () => {
    const t = await setup()
    await t.summarize()
    expect(t.store.tables.ai_usage).toHaveLength(1)
    expect(t.store.tables.ai_usage[0]).toMatchObject({
      ownerLineUserId: OWNER, groupId: t.group.id, purpose: 'summary',
      inputTokens: USAGE.inputTokens, outputTokens: USAGE.outputTokens,
    })
    expect(t.store.tables.ai_usage[0].ownerLineUserId).not.toBe(REQUESTER)
  })
})

describe('#5.9 decline', () => {
  it('all declined gives 0 tasks and candidates declined', async () => {
    const t = await setup()
    const { summaryId, cands } = await t.summarize()
    const res = await t.submit(summaryId, cands.map((c) => t.decline(c)))
    expect(results(res.body).map((r) => r.outcome)).toEqual(['declined', 'declined', 'declined'])
    expect(t.store.tables.tasks).toHaveLength(0)
    expect(cands.map((c) => t.candidate(c).state)).toEqual(['declined', 'declined', 'declined'])
  })
})

describe('#5.10 edit before create', () => {
  it('the Task stores the edits; the candidate keeps the model text', async () => {
    const t = await setup()
    const { summaryId, cands: [c1] } = await t.summarize()
    const res = await t.submit(summaryId, [t.confirm(c1, {
      title: 'ทำสไลด์ 12 หน้า', details: 'ส่งก่อนประชุม', assigneeLineUserId: 'Ucarol', dueAt: '2026-11-21T09:00:00+07:00',
    })])
    expect(res.status).toBe(200)
    const [task] = t.store.tables.tasks
    expect(task).toMatchObject({
      candidateId: c1, title: 'ทำสไลด์ 12 หน้า', details: 'ส่งก่อนประชุม',
      assigneeLineUserId: 'Ucarol', dueAt: new Date('2026-11-21T02:00:00Z'),
    })
    expect(t.candidate(c1)).toMatchObject({
      title: 'ทำสไลด์', details: 'Pim Sirin ทำ 10 หน้า', suggestedAssigneeLineUserId: 'Upim', state: 'confirmed',
    })
  })
})
