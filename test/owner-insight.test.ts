import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildOwnerInsight, OWNER_INSIGHT_TEXT, ownerInsightKey, postOwnerInsight } from '@/server/insight/owner'
import { handleTickRequest } from '@/server/tick/handle-request'
import { makeTestDeps, TEST_NOW, tickRequest } from './harness'

// #120: once a week, right after the main group's weekly insight, the Project's Owner gets a
// per-person card in the 1:1 chat, across the Project's groups. Group cards are unchanged.

const bkk = (s: string) => new Date(`${s}+07:00`)
const MONDAY_9 = bkk('2026-11-16T09:00:00')
const OWNER = 'Uowner1'
const DAY = 86_400_000

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/** Every text in a Flex tree. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  return [...(o.type === 'text' && typeof o.text === 'string' ? [o.text] : []), ...Object.values(o).flatMap(texts)]
}

async function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  const main = h.store.seedGroup({ lineGroupId: 'Cmain', name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: main.id, lineUserId: OWNER, displayName: 'Owner' })
  expect((await h.store.confirmGroupOwner(main.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((g) => g.id === main.id)!.projectId as string
  const sub = h.store.seedGroup({ lineGroupId: 'Csub', name: 'ทีมย่อย', projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
  h.store.seedMember({ groupId: main.id, lineUserId: 'Upim', displayName: 'Pim' })
  h.store.seedMember({ groupId: sub.id, lineUserId: 'Ubank', displayName: 'Bank' })
  for (const g of [main, sub]) h.store.tables.groups.find((x) => x.id === g.id)!.featureTrackRemind = false
  h.line.groupMemberCounts.set('Cmain', 3)
  h.line.groupMemberCounts.set('Csub', 3)
  const t = (groupId: string, title: string, extra: Record<string, unknown>) =>
    h.store.seedTask({ groupId, title, createdByLineUserId: OWNER, ...extra })
  // Pim (main group): one overdue and stale, one fine, one done this week, one done last week.
  t(main.id, 'A', { status: 'in_process', assigneeLineUserId: 'Upim', dueAt: new Date(MONDAY_9.getTime() - DAY), lastActivityAt: new Date(MONDAY_9.getTime() - 6 * DAY) })
  t(main.id, 'B', { status: 'in_process', assigneeLineUserId: 'Upim', lastActivityAt: MONDAY_9 })
  t(main.id, 'C', { status: 'done', assigneeLineUserId: 'Upim', doneAt: MONDAY_9, lastActivityAt: MONDAY_9 })
  t(main.id, 'D', { status: 'done', assigneeLineUserId: 'Upim', doneAt: new Date(MONDAY_9.getTime() - 8 * DAY), lastActivityAt: new Date(MONDAY_9.getTime() - 8 * DAY) })
  // Bank (Sub group): one in process. One unowned Task in the Sub group.
  t(sub.id, 'E', { status: 'in_process', assigneeLineUserId: 'Ubank', lastActivityAt: MONDAY_9 })
  t(sub.id, 'F', { status: 'not_assigned' })
  const tick = async (at: Date) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  return { ...h, main, sub, projectId, tick }
}

describe('the Owner card numbers (#120)', () => {
  it('counts per person across the Project, overdue and stale first', async () => {
    const s = await setup()
    s.setNow(MONDAY_9)
    const insight = await buildOwnerInsight(s.deps, s.projectId, s.main.id, MONDAY_9)
    expect(insight.people).toEqual([
      { lineUserId: 'Upim', name: 'Pim', inProcess: 2, doneThisWeek: 1, overdue: 1, stale: 1 },
      { lineUserId: 'Ubank', name: 'Bank', inProcess: 1, doneThisWeek: 0, overdue: 0, stale: 0 },
    ])
    expect(insight.unowned).toBe(1)
  })
})

describe('the Owner card on the tick (#120)', () => {
  it('goes to the Owner 1:1 once a week, after the group cards, counted as one message', async () => {
    const s = await setup()
    await s.tick(MONDAY_9)
    const toOwner = s.line.pushes.filter((p) => p.to === OWNER)
    expect(toOwner).toHaveLength(1)
    const lines = texts(toOwner[0].messages[0])
    expect(lines).toContain(OWNER_INSIGHT_TEXT.title)
    expect(lines).toContain('Pim')
    expect(lines).toContain(OWNER_INSIGHT_TEXT.line({ inProcess: 2, doneThisWeek: 1, overdue: 1, stale: 1 }))
    expect(lines).toContain(OWNER_INSIGHT_TEXT.unowned(1))
    // The group cards still go to the groups; the Owner card is one message in push_log.
    expect(s.line.pushes.filter((p) => p.to === 'Cmain' || p.to === 'Csub').length).toBeGreaterThanOrEqual(1)
    expect(s.store.tables.push_log.filter((r) => r.purpose === 'owner_insight')).toEqual([expect.objectContaining({ lineTargetId: OWNER, messageCount: 1 })])
    // Later ticks the same week send nothing more.
    await s.tick(new Date(MONDAY_9.getTime() + 15 * 60_000))
    expect(s.line.pushes.filter((p) => p.to === OWNER)).toHaveLength(1)
  })

  it('Members never get it, and a Sub group alone sends none', async () => {
    const s = await setup()
    s.setNow(MONDAY_9)
    expect(await postOwnerInsight(s.deps, s.sub.id, MONDAY_9)).toBe('not_main')
    await s.tick(MONDAY_9)
    expect(s.line.pushes.some((p) => p.to === 'Upim' || p.to === 'Ubank')).toBe(false)
  })

  it('near the quota it is skipped; the ledger keeps it to once a week', async () => {
    const s = await setup()
    s.line.quota = { limit: 300, used: 299 }
    s.setNow(MONDAY_9)
    expect(await postOwnerInsight(s.deps, s.main.id, MONDAY_9)).toBe('skipped_quota')
    expect(s.line.pushes.filter((p) => p.to === OWNER)).toEqual([])
    expect(s.store.tables.webhook_events.some((w) => w.webhookEventId === ownerInsightKey(s.projectId, '2026-11-16'))).toBe(true)
    expect(await postOwnerInsight(s.deps, s.main.id, MONDAY_9)).toBe('already_sent')
  })

  it('an Owner who is not a friend of the OA (LINE refuses) is logged, never fails the tick', async () => {
    const s = await setup()
    s.line.rejectPush = true // LINE answers 400 to a user who has not added the OA
    s.setNow(MONDAY_9)
    expect(await postOwnerInsight(s.deps, s.main.id, MONDAY_9)).toBe('failed')
    expect(s.store.tables.push_log.filter((r) => r.purpose === 'owner_insight')).toEqual([])
  })

  it('pauses while the Owner left (no confirmed Owner), and sends nothing for a Project with no Tasks', async () => {
    const s = await setup()
    s.store.tables.groups.find((g) => g.id === s.main.id)!.ownerConfirmedAt = null
    s.setNow(MONDAY_9)
    expect(await postOwnerInsight(s.deps, s.main.id, MONDAY_9)).not.toBe('pushed')
    const empty = await setup()
    empty.store.tables.tasks = []
    empty.setNow(MONDAY_9)
    expect(await postOwnerInsight(empty.deps, empty.main.id, MONDAY_9)).toBe('empty')
  })
})
