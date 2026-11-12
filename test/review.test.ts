import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent } from '@/server/line/types'
import type { LlmRequest } from '@/server/ports'
import { loadReview } from '@/server/review/load'
import { notifyReview } from '@/server/review/notify'
import { submitReview } from '@/server/review/submit'
import type { NotifyResult, ReviewView, SubmitResult } from '@/server/review/types'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { chatLines } from './fakes/prompt-reader'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม', 'Pim'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function refOf(user: string, lineName: string): string {
  const m = new RegExp(`^(m\\d+): LINE name "${lineName.replace(/[.]/g, '\\.')}"`, 'm').exec(user)
  if (!m) throw new Error(`no ref for ${lineName}`)
  return m[1]
}

/** Runs the real Summary flow (Task 7) so the candidates come from the webhook. */
async function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  h.store.seedMember({ groupId: group.id, lineUserId: 'Uleft', displayName: 'Left Person', leftAt: new Date(T0 - 60 * MIN) })
  h.line.idTokens.set('tok-pim', { lineUserId: 'Upim', displayName: 'Pim Sirin' })
  h.line.idTokens.set('tok-bank', { lineUserId: 'Ubank', displayName: 'Bank T.' })
  h.line.idTokens.set('tok-out', { lineUserId: 'Uoutsider', displayName: 'Outsider' })
  h.line.idTokens.set('tok-new', { lineUserId: 'Unew', displayName: null })
  h.line.idTokens.set('tok-left', { lineUserId: 'Uleft', displayName: 'Left Person' })
  h.line.profiles.set(`${group.lineGroupId}:Unew`, 'New Person')

  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  await send(
    ev.groupText({ text: 'ใครทำสไลด์ได้บ้าง', userId: 'Ubank', timestamp: T0 }),
    ev.groupText({ text: 'เดี๋ยวทำสไลด์เอง', userId: 'Upim', timestamp: T0 + MIN }),
  )
  h.llm.respond((req: LlmRequest) => {
    const pim = refOf(req.user, 'Pim Sirin')
    return {
      content: JSON.stringify({
        summary: `{${pim}} จะทำสไลด์`,
        tasks: [
          { title: 'ทำสไลด์', details: 'ทำ 10 หน้า', assignee: pim, due: '2026-11-20T17:00:00+07:00' },
          { title: 'จองห้อง', assignee: null },
        ],
      }),
      model: TEXT_MODEL,
      usage: { inputTokens: 100, outputTokens: 50, costUsd: null },
    }
  })
  await send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', timestamp: T0 + 2 * MIN }))

  const summaryId = h.store.tables.summaries[0].id
  const [c1, c2] = h.store.tables.task_candidates.map((c) => c.id)
  const candidate = (id: string) => h.store.tables.task_candidates.find((c) => c.id === id)!
  const submit = async (decisions: unknown[], extra: Record<string, unknown> = {}) =>
    submitReview(h.deps, { idToken: 'tok-pim', summaryId, decisions, ...extra })
  const confirm = (candidateId: string, p: Record<string, unknown> = {}) => ({
    candidateId, action: 'confirm', title: 'ทำสไลด์', details: null, assigneeLineUserId: 'Upim', dueAt: null, ...p,
  })
  const decline = (candidateId: string) => ({ candidateId, action: 'decline' })
  const notify = async (taskIds: unknown, idToken = 'tok-pim') => notifyReview(h.deps, { idToken, summaryId, taskIds })
  return { ...h, group, summaryId, c1, c2, candidate, submit, confirm, decline, send, notify }
}

function results(body: unknown) {
  return (body as SubmitResult).results
}

describe('loadReview', () => {
  it('1. returns the Summary, 2 proposed candidates and LINE names only', async () => {
    const t = await setup()
    const res = await loadReview(t.deps, { idToken: 'tok-pim', summaryId: t.summaryId })
    expect(res.status).toBe(200)
    const view = res.body as ReviewView
    expect(view.summaryId).toBe(t.summaryId)
    expect(view.summaryText).toBe('Pim Sirin จะทำสไลด์')
    expect(view.candidates).toHaveLength(2)
    expect(view.candidates.map((c) => c.state)).toEqual(['proposed', 'proposed'])
    expect(view.candidates[0]).toEqual({
      id: t.c1, state: 'proposed', title: 'ทำสไลด์', details: 'ทำ 10 หน้า',
      suggestedAssigneeLineUserId: 'Upim', suggestedDueAt: '2026-11-20T10:00:00.000Z',
    })
    for (const m of view.members) expect(Object.keys(m).sort()).toEqual(['displayName', 'lineUserId'])
    expect(view.members).toEqual(expect.arrayContaining([
      { lineUserId: 'Upim', displayName: 'Pim Sirin' },
      { lineUserId: 'Ubank', displayName: 'Bank T.' },
    ]))
    expect(view.members.some((m) => m.lineUserId === 'Uleft')).toBe(false)
    const json = JSON.stringify(view.members)
    for (const nick of ['พิม', 'แบงค์', 'nicknames']) expect(json).not.toContain(nick)
  })

  it('2. bad token 401, unknown summary 404, bad summaryId 400, outsider 403', async () => {
    const t = await setup()
    expect(await loadReview(t.deps, { idToken: 'tok-bad', summaryId: t.summaryId }))
      .toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(await loadReview(t.deps, { idToken: 'tok-pim', summaryId: randomUUID() }))
      .toEqual({ status: 404, body: { error: 'not_found' } })
    expect((await loadReview(t.deps, { idToken: 'tok-pim', summaryId: 'not-a-uuid' })).status).toBe(400)
    expect(await loadReview(t.deps, { idToken: 'tok-out', summaryId: t.summaryId }))
      .toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(await loadReview(t.deps, null)).toEqual({ status: 401, body: { error: 'unauthorized' } })
  })

  it('3. a user LINE says is in the group becomes a Member (source liff)', async () => {
    const t = await setup()
    const res = await loadReview(t.deps, { idToken: 'tok-new', summaryId: t.summaryId })
    expect(res.status).toBe(200)
    const row = t.store.tables.group_members.find((m) => m.lineUserId === 'Unew')
    expect(row).toMatchObject({ groupId: t.group.id, source: 'liff', leftAt: null })
    expect(t.store.tables.line_users.find((u) => u.lineUserId === 'Unew')?.displayName).toBe('New Person')
  })

  it('4. a left Member gets 403', async () => {
    const t = await setup()
    expect(await loadReview(t.deps, { idToken: 'tok-left', summaryId: t.summaryId }))
      .toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(t.line.profileCalls).toHaveLength(0)
  })
})

describe('submitReview', () => {
  it('5. a Task exists only after confirm', async () => {
    const t = await setup()
    await loadReview(t.deps, { idToken: 'tok-pim', summaryId: t.summaryId })
    expect(t.store.tables.tasks).toHaveLength(0)
    const res = await t.submit([t.confirm(t.c1)])
    expect(res.status).toBe(200)
    expect(t.store.tables.tasks).toHaveLength(1)
  })

  it('6. edit before create: the Task takes the edited values, the candidate keeps its own', async () => {
    const t = await setup()
    const res = await t.submit([t.confirm(t.c1, {
      title: 'ทำสไลด์ 10 หน้า', details: 'ส่งก่อนประชุม', assigneeLineUserId: 'Ubank', dueAt: '2026-11-21T09:00:00+07:00',
    })])
    expect(res.status).toBe(200)
    const [task] = t.store.tables.tasks
    expect(results(res.body)).toEqual([{ candidateId: t.c1, outcome: 'created', taskId: task.id }])
    expect(task).toMatchObject({
      groupId: t.group.id, candidateId: t.c1, title: 'ทำสไลด์ 10 หน้า', details: 'ส่งก่อนประชุม',
      assigneeLineUserId: 'Ubank', dueAt: new Date('2026-11-21T02:00:00Z'),
    })
    expect(t.candidate(t.c1)).toMatchObject({
      title: 'ทำสไลด์', state: 'confirmed', decidedByLineUserId: 'Upim', decidedAt: t.deps.now(),
    })
  })

  it('7. a tagged person is the owner; no one tagged is Not Assigned', async () => {
    const t = await setup()
    await t.submit([t.confirm(t.c1, { assigneeLineUserId: 'Ubank' }), t.confirm(t.c2, { title: 'จองห้อง', assigneeLineUserId: null })])
    const byCandidate = (id: string) => t.store.tables.tasks.find((x) => x.candidateId === id)!
    expect(byCandidate(t.c1)).toMatchObject({ assigneeLineUserId: 'Ubank', status: 'in_process' })
    expect(byCandidate(t.c2)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
  })

  it('8. the confirmer is recorded as creator', async () => {
    const t = await setup()
    t.line.idTokens.set('tok-bank', { lineUserId: 'Ubank', displayName: 'Bank T.' })
    await submitReview(t.deps, { idToken: 'tok-bank', summaryId: t.summaryId, decisions: [t.confirm(t.c1)] })
    expect(t.store.tables.tasks[0].createdByLineUserId).toBe('Ubank')
    expect(t.store.tables.summaries[0].requestedByLineUserId).toBe('Upim')
    expect(t.candidate(t.c1).decidedByLineUserId).toBe('Ubank')
  })

  it('8b. creator is the confirmer, not the Owner', async () => {
    const t = await setup()
    await t.submit([t.confirm(t.c1)])
    expect(t.store.tables.tasks[0].createdByLineUserId).toBe('Upim')
    expect(t.store.tables.tasks[0].createdByLineUserId).not.toBe(t.group.nominatedOwnerLineUserId)
  })

  it('9. several at once: confirm c1 and decline c2', async () => {
    const t = await setup()
    const res = await t.submit([t.confirm(t.c1), t.decline(t.c2)])
    expect(res.status).toBe(200)
    expect(results(res.body).map((r) => r.outcome)).toEqual(['created', 'declined'])
    expect(t.store.tables.tasks).toHaveLength(1)
    expect(t.candidate(t.c2)).toMatchObject({ state: 'declined', decidedByLineUserId: 'Upim' })
    expect(t.store.tables.tasks.some((x) => x.candidateId === t.c2)).toBe(false)
  })

  it('10. decline only creates no Task', async () => {
    const t = await setup()
    const res = await t.submit([t.decline(t.c1), t.decline(t.c2)])
    expect(results(res.body)).toEqual([
      { candidateId: t.c1, outcome: 'declined' },
      { candidateId: t.c2, outcome: 'declined' },
    ])
    expect(t.store.tables.tasks).toHaveLength(0)
    expect([t.candidate(t.c1).state, t.candidate(t.c2).state]).toEqual(['declined', 'declined'])
  })

  it('11. resubmitting the same confirm is already_decided with the same taskId', async () => {
    const t = await setup()
    const first = await t.submit([t.confirm(t.c1)])
    const taskId = results(first.body)[0].taskId
    const again = await t.submit([t.confirm(t.c1)])
    expect(again.status).toBe(200)
    expect(results(again.body)).toEqual([{ candidateId: t.c1, outcome: 'already_decided', taskId }])
    expect(t.store.tables.tasks).toHaveLength(1)
    // A declined candidate stays declined (D30).
    await t.submit([t.decline(t.c2)])
    const re = await t.submit([t.confirm(t.c2, { title: 'จองห้อง' })])
    expect(results(re.body)).toEqual([{ candidateId: t.c2, outcome: 'already_decided' }])
    const reDecline = await t.submit([t.decline(t.c1)])
    expect(results(reDecline.body)).toEqual([{ candidateId: t.c1, outcome: 'already_decided' }])
    expect(t.store.tables.tasks).toHaveLength(1)
  })

  it('12. an assignee who is not a live Member gives 400 and writes nothing', async () => {
    const t = await setup()
    for (const who of ['Ustranger', 'Uleft']) {
      const res = await t.submit([t.decline(t.c2), t.confirm(t.c1, { assigneeLineUserId: who })])
      expect(res).toEqual({ status: 400, body: { error: 'bad_request', field: 'assigneeLineUserId' } })
    }
    expect(t.store.tables.tasks).toHaveLength(0)
    expect([t.candidate(t.c1).state, t.candidate(t.c2).state]).toEqual(['proposed', 'proposed'])
  })

  it('13. a candidate from another summary gives 400 and writes nothing', async () => {
    const t = await setup()
    const res = await t.submit([t.decline(t.c2), t.confirm(randomUUID())])
    expect(res).toEqual({ status: 400, body: { error: 'bad_request', field: 'candidateId' } })
    expect(t.store.tables.tasks).toHaveLength(0)
    expect(t.candidate(t.c2).state).toBe('proposed')
  })

  it('14. an empty title gives 400 with field title', async () => {
    const t = await setup()
    expect(await t.submit([t.confirm(t.c1, { title: '  ' })]))
      .toEqual({ status: 400, body: { error: 'bad_request', field: 'title' } })
  })

  it('14b. rejects bad decision lists', async () => {
    const t = await setup()
    const bad = { status: 400, body: { error: 'bad_request', field: 'decisions' } }
    expect(await t.submit([])).toEqual(bad)
    expect(await submitReview(t.deps, { idToken: 'tok-pim', summaryId: t.summaryId })).toEqual(bad)
    expect(await t.submit(Array.from({ length: 11 }, () => t.decline(t.c1)))).toEqual(bad)
    expect(await t.submit([t.decline(t.c1), t.decline(t.c1)]))
      .toEqual({ status: 400, body: { error: 'bad_request', field: 'candidateId' } })
    expect(await t.submit([{ candidateId: t.c1, action: 'maybe' }]))
      .toEqual({ status: 400, body: { error: 'bad_request', field: 'action' } })
    expect(await t.submit([{ candidateId: t.c1, action: 'confirm', title: 'x' }]))
      .toEqual({ status: 400, body: { error: 'bad_request', field: 'details' } })
    expect(t.store.tables.tasks).toHaveLength(0)
  })

  it('14c. auth, summary and access checks match loadReview', async () => {
    const t = await setup()
    const decisions = [t.decline(t.c1)]
    expect((await submitReview(t.deps, { idToken: 'tok-bad', summaryId: t.summaryId, decisions })).status).toBe(401)
    expect((await submitReview(t.deps, { idToken: 'tok-pim', summaryId: 'x', decisions })).status).toBe(400)
    expect((await submitReview(t.deps, { idToken: 'tok-pim', summaryId: randomUUID(), decisions })).status).toBe(404)
    expect((await submitReview(t.deps, { idToken: 'tok-out', summaryId: t.summaryId, decisions })).status).toBe(403)
    expect((await submitReview(t.deps, { idToken: 'tok-left', summaryId: t.summaryId, decisions })).status).toBe(403)
    expect(t.candidate(t.c1).state).toBe('proposed')
  })

  it('15. heals a Task left by a crash while its candidate is still proposed (L3)', async () => {
    const t = await setup()
    const seeded = t.store.seedTask({ groupId: t.group.id, candidateId: t.c1, title: 'ทำสไลด์', createdByLineUserId: 'Upim' })
    const res = await t.submit([t.confirm(t.c1)])
    expect(results(res.body)).toEqual([{ candidateId: t.c1, outcome: 'already_decided', taskId: seeded.id }])
    expect(t.candidate(t.c1)).toMatchObject({ state: 'confirmed', decidedByLineUserId: 'Upim' })
    expect(t.store.tables.tasks).toHaveLength(1)
  })

  it('15b. a decline by another Member after this submit loaded the candidate wins', async () => {
    const t = await setup()
    // Another Member declines c1 between this submit's read and its confirm.
    const list = t.store.listCandidates.bind(t.store)
    vi.spyOn(t.store, 'listCandidates').mockImplementation(async (summaryId) => {
      const rows = await list(summaryId)
      await t.store.decideCandidate(t.c1, 'declined', 'Ubank', t.deps.now())
      return rows
    })
    const res = await t.submit([t.confirm(t.c1)])
    expect(res.status).toBe(200)
    expect(results(res.body)).toEqual([{ candidateId: t.c1, outcome: 'already_decided' }])
    expect(t.store.tables.tasks).toHaveLength(0)
    expect(t.candidate(t.c1)).toMatchObject({ state: 'declined', decidedByLineUserId: 'Ubank' })
  })

  it('16. a client-sent user ID is ignored', async () => {
    const t = await setup()
    await t.submit([t.confirm(t.c1)], { lineUserId: 'Uowner1', userId: 'Uowner1' })
    expect(t.store.tables.tasks[0].createdByLineUserId).toBe('Upim')
    expect(t.candidate(t.c1).decidedByLineUserId).toBe('Upim')
    expect(await loadReview(t.deps, { lineUserId: 'Upim', summaryId: t.summaryId }))
      .toEqual({ status: 401, body: { error: 'unauthorized' } })
  })
})

function createdIds(body: unknown): string[] {
  return results(body).flatMap((r) => (r.outcome === 'created' && r.taskId ? [r.taskId] : []))
}

describe('Tasks created feedback', () => {
  it('17. submit returns the group message for the Tasks it created, with LINE names', async () => {
    const t = await setup()
    const res = await t.submit([
      t.confirm(t.c1, { dueAt: '2026-11-20T10:00:00.000Z' }),
      t.confirm(t.c2, { title: 'จองห้อง', assigneeLineUserId: null }),
    ])
    expect((res.body as SubmitResult).feedback?.text).toBe(
      '✅ สร้างงานแล้ว 2 งาน\n1. ทำสไลด์\n   ผู้รับ: Pim Sirin · กำหนด: 20 พ.ย. 17:00\n2. จองห้อง\n   ผู้รับ: ยังไม่มีผู้รับ · กำหนด: ไม่ระบุ',
    )
  })

  it('17b. no feedback when nothing is waiting to be announced', async () => {
    const t = await setup()
    expect((await t.submit([t.decline(t.c1)])).body).toMatchObject({ feedback: null })
  })

  it('17d. a retry after a lost response still carries the unannounced Tasks', async () => {
    const t = await setup()
    const first = (await t.submit([t.confirm(t.c2)])).body as SubmitResult
    const retry = (await t.submit([t.confirm(t.c2)])).body as SubmitResult
    expect(results(retry)[0].outcome).toBe('already_decided')
    expect(retry.feedback).toEqual(first.feedback)
    // Once announced, a resubmit offers nothing.
    await t.notify(first.feedback!.taskIds)
    expect((await t.submit([t.confirm(t.c2)])).body).toMatchObject({ feedback: null })
  })

  it('17e. two pages announcing the same Tasks push the message once', async () => {
    const t = await setup()
    const { feedback } = (await t.submit([t.confirm(t.c1)])).body as SubmitResult
    const ids = feedback!.taskIds
    const [a, b] = await Promise.all([t.notify(ids), t.notify(ids)])
    expect([a.body, b.body]).toEqual(expect.arrayContaining([
      { posted: true }, { posted: false, reason: 'already_announced' },
    ]))
    expect(t.line.pushes).toHaveLength(1)
    // Once announced, a resubmit offers nothing.
    expect((await t.submit([t.confirm(t.c1)])).body).toMatchObject({ feedback: null })
  })

  it('18. notify pushes once to the group and logs one message per live Member', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    const res = await t.notify(ids)
    expect(res).toEqual({ status: 200, body: { posted: true } satisfies NotifyResult })
    expect(t.line.pushes).toHaveLength(1)
    expect(t.line.pushes[0].to).toBe(t.group.lineGroupId)
    expect(t.line.pushes[0].messages[0]).toMatchObject({ type: 'text', text: expect.stringContaining('1. ทำสไลด์') })
    const live = (await t.store.listLiveMembers(t.group.id)).length
    expect(t.store.tables.push_log).toEqual([
      { id: expect.any(String), purpose: 'task_created', lineTargetId: t.group.lineGroupId, messageCount: live, sentAt: expect.any(Date) },
    ])
    // A second call (double tap, retry) never pushes the same Tasks again.
    expect((await t.notify(ids)).body).toEqual({ posted: false, reason: 'already_announced' })
    expect(t.line.pushes).toHaveLength(1)
  })

  it('19. near the quota limit it skips the push and leaves the Tasks unannounced', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    t.line.quota = { limit: 300, used: 269 } // 269 + 3 Members > 90% of 300
    expect((await t.notify(ids)).body).toEqual({ posted: false, reason: 'quota' })
    expect(t.line.pushes).toHaveLength(0)
    expect(t.store.tables.push_log).toHaveLength(0)
    t.line.quota = { limit: 300, used: 0 }
    expect((await t.notify(ids)).body).toEqual({ posted: true })
  })

  it('19c. two announces at once cannot together spend the reserve', async () => {
    const t = await setup()
    const [a, b] = [t.c1, t.c2]
    const ids = createdIds((await t.submit([t.confirm(a), t.confirm(b, { title: 'จองห้อง' })])).body)
    // allowed = 270; each push counts 3. LINE still reports 265 after the first push.
    t.line.quota = { limit: 300, used: 265 }
    expect((await t.notify([ids[0]])).body).toEqual({ posted: true })
    expect((await t.notify([ids[1]])).body).toEqual({ posted: false, reason: 'quota' })
  })

  it('19b. a plan without a limit always pushes', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    t.line.quota = { limit: null, used: 100_000 }
    expect((await t.notify(ids)).body).toEqual({ posted: true })
  })

  it('20. a failed push gives 502 and a retry can still announce', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    t.line.failPush = true
    expect((await t.notify(ids)).status).toBe(502)
    expect(t.store.tables.push_log).toHaveLength(0)
    t.line.failPush = false
    expect((await t.notify(ids)).body).toEqual({ posted: true })
    expect(t.line.pushes).toHaveLength(2) // the failed attempt and the retry
  })

  it('20b. a push LINE accepted before the answer was lost is not sent twice', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    t.line.timeoutAfterAccept = true
    expect((await t.notify(ids)).status).toBe(502)
    t.line.timeoutAfterAccept = false
    expect((await t.notify(ids)).body).toEqual({ posted: true })
    expect(t.line.delivered).toHaveLength(1)
  })

  it('21. only the confirmer can announce Tasks of this Summary', async () => {
    const t = await setup()
    const ids = createdIds((await t.submit([t.confirm(t.c1)])).body)
    // Another Member's call announces nothing of Pim's.
    expect((await t.notify(ids, 'tok-bank')).body).toEqual({ posted: false, reason: 'nothing_to_announce' })
    expect((await t.notify([randomUUID()])).status).toBe(400)
    expect((await t.notify([])).status).toBe(400)
    expect((await t.notify(['not-a-uuid'])).status).toBe(400)
    expect((await t.notify([ids[0], ids[0]])).status).toBe(400)
    const other = t.store.seedTask({ groupId: t.group.id, title: 'อื่น', createdByLineUserId: 'Upim' })
    expect((await t.notify([other.id])).status).toBe(400)
    expect((await t.notify(ids, 'bad-token')).status).toBe(401)
    expect(t.line.pushes).toHaveLength(0)
  })

  it('22. the next Summary skips the feedback message a LIFF page posted', async () => {
    const t = await setup()
    const feedback = (await t.submit([t.confirm(t.c1)])).body as SubmitResult
    await t.send(ev.groupText({ text: feedback.feedback!.text, userId: 'Upim', timestamp: T0 + 3 * MIN }))
    let read: string[] = []
    t.llm.respond((req: LlmRequest) => {
      read = chatLines(req).map((c) => c.text)
      return { content: JSON.stringify({ summary: 'x', tasks: [] }), model: TEXT_MODEL, usage: null }
    })
    await t.send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', timestamp: T0 + 4 * MIN }))
    expect(read).toEqual(['ใครทำสไลด์ได้บ้าง', 'เดี๋ยวทำสไลด์เอง'])
  })
})
