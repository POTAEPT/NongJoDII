import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addTag, removeTag, TAGS_TEXT } from '@/app/liff/tags-model'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import type { LineEvent } from '@/server/line/types'
import type { LlmRequest } from '@/server/ports'
import { loadReview } from '@/server/review/load'
import { submitReview } from '@/server/review/submit'
import type { ReviewView, SubmitResult } from '@/server/review/types'
import { cleanTag, personTags, suggestedTags, TAG_MAX_LENGTH, TAGS_MAX } from '@/server/tasks/tags'
import { loadTask } from '@/server/tasks/load'
import { updateTaskFromLiff } from '@/server/tasks/update'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #109: Tasks carry tags. The Summary's model suggests them (reusing the group's tags in
// use), the person keeps, edits or removes them on the review page and the Task page, and
// the Dashboard shows them. A model that gives no tags never blocks a Task.

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0) // 09:00 Bangkok
const MIN = 60_000
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('tag rules (server/tasks/tags.ts)', () => {
  it('cleanTag trims, collapses spaces, drops a leading # and cuts at the length cap', () => {
    expect(cleanTag('  #ออกแบบ  ')).toBe('ออกแบบ')
    expect(cleanTag('งาน   เอกสาร')).toBe('งาน เอกสาร')
    expect(cleanTag('#')).toBeNull()
    expect(Array.from(cleanTag('ก'.repeat(30))!)).toHaveLength(TAG_MAX_LENGTH)
  })

  it('suggestedTags never fails: drops non-strings and duplicates, keeps at most 3', () => {
    expect(suggestedTags(null)).toEqual([])
    expect(suggestedTags(['ออกแบบ', 1, '#ออกแบบ', 'Docs', 'docs', 'เอกสาร', 'ประชุม'])).toEqual(['ออกแบบ', 'Docs', 'เอกสาร'])
  })

  it('personTags refuses what a person cannot send, and treats a missing list as none', () => {
    expect(personTags(undefined)).toEqual([])
    expect(personTags(['ออกแบบ', 'ออกแบบ'])).toEqual(['ออกแบบ'])
    expect(personTags('ออกแบบ')).toBeNull()
    expect(personTags([''])).toBeNull()
    expect(personTags(['ก'.repeat(TAG_MAX_LENGTH + 1)])).toBeNull()
    expect(personTags(Array.from({ length: TAGS_MAX + 1 }, (_, i) => `t${i}`))).toBeNull()
  })
})

describe('tag editor rules (app/liff/tags-model.ts)', () => {
  it('adds a typed tag, refuses duplicates, too-long and over-the-cap tags, and removes', () => {
    expect(addTag([], ' #ออกแบบ ')).toEqual({ tags: ['ออกแบบ'], error: null })
    expect(addTag(['ออกแบบ'], 'ออกแบบ')).toEqual({ tags: ['ออกแบบ'], error: TAGS_TEXT.duplicate })
    expect(addTag([], 'ก'.repeat(TAG_MAX_LENGTH + 1)).error).toBe(TAGS_TEXT.tooLong)
    expect(addTag(['a', 'b', 'c', 'd', 'e'], 'f').error).toBe(TAGS_TEXT.full())
    expect(addTag(['a'], '   ')).toEqual({ tags: ['a'], error: null })
    expect(removeTag(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('migration 20261116160000_task_tags.sql', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261116160000_task_tags.sql'), 'utf8').toLowerCase()
  it('adds the two columns with an empty default and a count cap', () => {
    expect(sql).toContain("add column tags text[] not null default '{}'")
    expect(sql).toContain('check (cardinality(tags) <= 5)')
    expect(sql).toContain("add column suggested_tags text[] not null default '{}'")
    expect(sql).toContain('check (cardinality(suggested_tags) <= 5)')
  })
})

/** A group, a chat and a Summary whose model answer is `tasks`. */
async function setup(tasks: unknown[]) {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  h.line.idTokens.set('tok-pim', { lineUserId: 'Upim', displayName: 'Pim Sirin' })
  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  const summarize = async (at: number) => {
    h.llm.respond(() => ({
      content: JSON.stringify({ summary: 'คุยเรื่องงาน', tasks }),
      model: TEXT_MODEL, usage: { inputTokens: 100, outputTokens: 50, costUsd: null },
    }))
    await send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', timestamp: at }))
  }
  await send(ev.groupText({ text: 'ทำสไลด์กับเขียนรายงานนะ', userId: 'Ubank', timestamp: T0 }))
  await summarize(T0 + MIN)
  const summaryId = h.store.tables.summaries[0]?.id
  return { ...h, group, send, summarize, summaryId }
}

const base = { details: null, assignee: null, due: null, source: null }

describe('the Summary suggests tags (#109)', () => {
  it('stores the model\'s tags on each candidate, cleaned, and drops a tag that names a member', async () => {
    const t = await setup([
      { ...base, title: 'ทำสไลด์', tags: ['#ออกแบบ', 'สไลด์', 'ออกแบบ'] },
      { ...base, title: 'เขียนรายงาน', tags: ['{m1}', 'เอกสาร'] },
      { ...base, title: 'จองห้อง' }, // the model gave no tags
    ])
    expect(t.store.tables.task_candidates.map((c) => c.suggestedTags)).toEqual([['ออกแบบ', 'สไลด์'], ['เอกสาร'], []])
    const view = (await loadReview(t.deps, { idToken: 'tok-pim', summaryId: t.summaryId })).body as ReviewView
    expect(view.candidates.map((c) => c.suggestedTags)).toEqual([['ออกแบบ', 'สไลด์'], ['เอกสาร'], []])
  })

  it('tells the model the tags already in use, so it can reuse them', async () => {
    const t = await setup([])
    t.store.seedTask({ groupId: t.group.id, title: 'ทำโปสเตอร์', createdByLineUserId: 'Upim', tags: ['ออกแบบ'] })
    await t.send(ev.groupText({ text: 'ต้องทำแบนเนอร์ด้วย', userId: 'Ubank', timestamp: T0 + 5 * MIN }))
    const before = t.llm.requests.length
    await t.summarize(T0 + 6 * MIN)
    const summaryCall = t.llm.requests.slice(before).find((r: LlmRequest) => r.system.includes('"summary": string'))!
    expect(summaryCall.user).toContain('Tags in use: ออกแบบ')
    expect(summaryCall.system).toContain('tags: 0 to 3 short labels')
  })
})

describe('the person keeps or edits the tags (#109)', () => {
  const answer = [{ ...base, title: 'ทำสไลด์', tags: ['ออกแบบ'] }, { ...base, title: 'เขียนรายงาน', tags: ['เอกสาร'] }]
  const confirm = (candidateId: string, extra: Record<string, unknown> = {}) => ({
    candidateId, action: 'confirm', title: 'x', details: null, assigneeLineUserId: null, dueAt: null, ...extra,
  })

  it('the review page saves the tags sent; a confirm without tags keeps the suggestion', async () => {
    const t = await setup(answer)
    const [c1, c2] = t.store.tables.task_candidates.map((c) => c.id)
    const res = await submitReview(t.deps, {
      idToken: 'tok-pim', summaryId: t.summaryId,
      decisions: [confirm(c1, { title: 'ทำสไลด์', tags: ['ออกแบบ', 'ด่วน'] }), confirm(c2, { title: 'เขียนรายงาน' })],
    })
    expect(res.status).toBe(200)
    const ids = (res.body as SubmitResult).results.map((r) => r.taskId!)
    expect(t.store.tables.tasks.find((x) => x.id === ids[0])!.tags).toEqual(['ออกแบบ', 'ด่วน'])
    expect(t.store.tables.tasks.find((x) => x.id === ids[1])!.tags).toEqual(['เอกสาร'])
  })

  it('refuses tags a person cannot send, and writes nothing', async () => {
    const t = await setup(answer)
    const [c1] = t.store.tables.task_candidates.map((c) => c.id)
    const res = await submitReview(t.deps, {
      idToken: 'tok-pim', summaryId: t.summaryId, decisions: [confirm(c1, { title: 'ทำสไลด์', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })],
    })
    expect(res).toEqual({ status: 400, body: { error: 'bad_request', field: 'tags' } })
    expect(t.store.tables.tasks).toHaveLength(0)
  })

  it('the Task page shows, edits and keeps the tags', async () => {
    const t = await setup(answer)
    const task = t.store.seedTask({ groupId: t.group.id, title: 'ทำสไลด์', createdByLineUserId: 'Upim', tags: ['ออกแบบ'] })
    const loaded = await loadTask(t.deps, { idToken: 'tok-pim', taskId: task.id })
    expect((loaded.body as { tags: string[] }).tags).toEqual(['ออกแบบ'])
    const fields = { idToken: 'tok-pim', taskId: task.id, title: 'ทำสไลด์', details: null, assigneeLineUserId: null, dueAt: null }
    expect((await updateTaskFromLiff(t.deps, { ...fields, tags: ['ออกแบบ', 'ด่วน'] })).status).toBe(200)
    expect(t.store.tables.tasks.find((x) => x.id === task.id)!.tags).toEqual(['ออกแบบ', 'ด่วน'])
    // No tags field: the Task keeps its tags (an older page).
    expect((await updateTaskFromLiff(t.deps, fields)).status).toBe(200)
    expect(t.store.tables.tasks.find((x) => x.id === task.id)!.tags).toEqual(['ออกแบบ', 'ด่วน'])
    expect(await updateTaskFromLiff(t.deps, { ...fields, tags: 'ออกแบบ' })).toEqual({ status: 400, body: { error: 'bad_request', field: 'tags' } })
  })

  it('the Dashboard carries each Task\'s tags', async () => {
    const h = makeTestDeps()
    h.line.idTokens.set('tok-pim', { lineUserId: 'Upim', displayName: 'Pim Sirin' })
    const project = h.store.seedProject('Upim')
    const g = h.store.seedGroup({ lineGroupId: 'Cdash', name: 'ทีม', projectId: project.id, nominatedOwnerLineUserId: 'Upim', ownerConfirmedAt: new Date(T0) })
    h.store.seedMember({ groupId: g.id, lineUserId: 'Upim', displayName: 'Pim Sirin' })
    h.store.seedTask({ groupId: g.id, title: 'ทำสไลด์', createdByLineUserId: 'Upim', tags: ['ออกแบบ'] })
    const res = await loadDashboard(h.deps, { idToken: 'tok-pim' })
    expect(res.status).toBe(200)
    const data = res.body as DashboardData
    expect(data.groups[0].tasks.find((x) => x.title === 'ทำสไลด์')!.tags).toEqual(['ออกแบบ'])
  })
})
