import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEEKLY_CARD_TEXT } from '@/server/insight/card'
import { WEEKLY_PUSH_RESERVE } from '@/server/insight/weekly'
import { retryKeyFrom } from '@/server/line/push-budget'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { FakeStore } from './fakes/fake-store'
import { TEST_LIFF_ID, makeTestDeps, seedOwnedGroup, tickRequest } from './harness'

// #21 through the tick seam: pg_cron's POST goes in; the group post (a LINE push), the
// push_log row and weekly_insights.posted_at come out. Monday 09:00 Bangkok is the default
// weekly slot. LINE's quota in the fake is 300 messages a month.

const bkk = (s: string) => new Date(`${s}+07:00`)
const QUARTER = 15 * 60_000
const MONDAY_9 = bkk('2026-11-16T09:00:00')

function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  const tickAt = async (at: Date) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const ticksBetween = async (from: Date, to: Date) => {
    for (let t = from.getTime(); t <= to.getTime(); t += QUARTER) await tickAt(new Date(t))
  }
  return { ...h, tickAt, ticksBetween }
}

/** A set-up group with 5 people in LINE and some Tasks. Daily reminders (#44) are off so
 *  every push here is the weekly post; how both share a tick is in daily-reminders.test.ts. */
function seedGroup(store: FakeStore, line: ReturnType<typeof setup>['line'], lineGroupId = 'Cgroup1', name = 'ทีมอีเวนต์') {
  const group = seedOwnedGroup(store, { lineGroupId })
  const row = store.tables.groups.find((g) => g.id === group.id)!
  row.name = name
  row.featureTrackRemind = false
  line.groupMemberCounts.set(lineGroupId, 5)
  const base = { groupId: group.id, createdByLineUserId: 'Uowner1' }
  store.seedTask({ ...base, title: 'Logo', status: 'done', assigneeLineUserId: 'Uowner1' })
  store.seedTask({ ...base, title: 'Slides', status: 'in_process', assigneeLineUserId: 'Uowner1' })
  store.seedTask({ ...base, title: 'Budget', status: 'not_assigned' })
  return group
}

const insightOf = (store: FakeStore, groupId: string) => store.tables.weekly_insights.find((w) => w.groupId === groupId)

/** Every text in a Flex tree. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  return [...(o.type === 'text' && typeof o.text === 'string' ? [o.text] : []), ...Object.values(o).flatMap(texts)]
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('weekly insight group post (#21)', () => {
  it('posts one card to the group at its weekly slot, then marks the insight posted', async () => {
    const { store, line, llm, ticksBetween } = setup()
    const group = seedGroup(store, line)

    await ticksBetween(bkk('2026-11-16T08:00:00'), bkk('2026-11-16T08:45:00'))
    expect(line.pushes).toHaveLength(0)

    await ticksBetween(MONDAY_9, bkk('2026-11-16T12:00:00'))
    expect(line.pushes).toHaveLength(1)
    const push = line.pushes[0]
    expect(push.to).toBe('Cgroup1')
    expect(push.messages).toHaveLength(1)
    const card = push.messages[0]
    if (card.type !== 'flex') throw new Error('expected a Flex card')
    expect(card.altText).toBe(`${WEEKLY_CARD_TEXT.title}: เสร็จ 1 · กำลังทำ 1 · ยังไม่มีผู้รับ 1`)
    expect(texts(card.contents)).toEqual(expect.arrayContaining(['ทีมอีเวนต์ · 16–22 พ.ย.', '• Budget']))
    expect(JSON.stringify(card.contents)).toContain(`https://liff.line.me/${TEST_LIFF_ID}?view=dashboard&id=${group.id}`)

    expect(insightOf(store, group.id)?.postedAt).toEqual(MONDAY_9)
    expect(llm.requests).toHaveLength(0)
  })

  it('counts every person in the LINE group in the push budget', async () => {
    const { store, line, tickAt } = setup()
    seedGroup(store, line)
    await tickAt(MONDAY_9)
    expect(store.tables.push_log).toEqual([
      expect.objectContaining({ purpose: 'weekly_insight', lineTargetId: 'Cgroup1', messageCount: 5 }),
    ])
  })

  it('sends the same LINE retry key for the same group and week', async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    const keys: Array<string | undefined> = []
    const push = line.push.bind(line)
    vi.spyOn(line, 'push').mockImplementation(async (to, messages, opts) => {
      keys.push(opts?.retryKey)
      return push(to, messages, opts)
    })
    await tickAt(MONDAY_9)
    expect(keys).toEqual([retryKeyFrom(`weekly_insight:${group.id}:2026-11-16`)])
  })

  it('posts once a week, and again the next week', async () => {
    const { store, line, tickAt } = setup()
    seedGroup(store, line)
    await tickAt(MONDAY_9)
    await tickAt(bkk('2026-11-16T09:15:00'))
    await tickAt(bkk('2026-11-23T09:00:00'))
    expect(line.pushes).toHaveLength(2)
  })

  it('posts nothing for a group with no Tasks', async () => {
    const { store, line, tickAt } = setup()
    const group = seedOwnedGroup(store)
    line.groupMemberCounts.set(group.lineGroupId, 5)
    await tickAt(MONDAY_9)
    expect(insightOf(store, group.id)).toMatchObject({ counts: { done: 0, inProcess: 0, awaitingOwner: 0 }, postedAt: null })
    expect(line.pushes).toHaveLength(0)
    expect(store.tables.push_log).toHaveLength(0)
  })

  it(`skips the post when it would pass ${100 - WEEKLY_PUSH_RESERVE * 100}% of the quota, and keeps the insight for the Dashboard`, async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    line.quota = { limit: 300, used: 266 } // 266 + 5 people = 271 > 270
    await tickAt(MONDAY_9)
    expect(line.pushes).toHaveLength(0)
    expect(store.tables.push_log).toHaveLength(0)
    expect(insightOf(store, group.id)).toMatchObject({ counts: { done: 1, inProcess: 1, awaitingOwner: 1 }, postedAt: null })
  })

  it('posts when the push just fits under the reserve', async () => {
    const { store, line, tickAt } = setup()
    seedGroup(store, line)
    line.quota = { limit: 300, used: 265 } // 265 + 5 = 270
    await tickAt(MONDAY_9)
    expect(line.pushes).toHaveLength(1)
  })

  it('uses the larger of LINE\'s member count and the stored Members', async () => {
    const { store, line, tickAt } = setup()
    seedGroup(store, line)
    line.groupMemberCounts.set('Cgroup1', 0) // LINE answered 0; the stored Owner still counts
    await tickAt(MONDAY_9)
    expect(store.tables.push_log[0].messageCount).toBe(1)
  })

  it('keeps the insight and frees the budget when LINE rejects the push', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    line.failPush = true
    await tickAt(MONDAY_9)
    expect(line.pushes).toHaveLength(1) // attempted
    expect(insightOf(store, group.id)?.postedAt).toBeNull()
    expect(store.tables.push_log).toHaveLength(0)
    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain('group_push_failed')

    // The week's insight is not saved twice, and the post is not retried later the same day.
    line.failPush = false
    await tickAt(bkk('2026-11-16T09:15:00'))
    expect(store.tables.weekly_insights.filter((w) => w.groupId === group.id)).toHaveLength(1)
    expect(line.pushes).toHaveLength(1)
  })

  it('keeps the insight when the quota lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    line.failQuota = true
    await tickAt(MONDAY_9)
    expect(line.pushes).toHaveLength(0)
    expect(insightOf(store, group.id)?.postedAt).toBeNull()
  })

  it('still posts when the group name cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, line, tickAt } = setup()
    seedGroup(store, line)
    store.failNext('getGroupById')
    await tickAt(MONDAY_9)
    expect(line.pushes).toHaveLength(1)
    const card = line.pushes[0].messages[0]
    if (card.type !== 'flex') throw new Error('expected a Flex card')
    expect(texts(card.contents)).toContain('16–22 พ.ย.')
  })

  it('posts to each group at its own time', async () => {
    const { store, line, ticksBetween } = setup()
    seedGroup(store, line, 'Ca', 'A')
    const b = seedGroup(store, line, 'Cb', 'B')
    store.seedSchedule(b.id, { weeklySummaryTime: '13:00:00' })
    await ticksBetween(MONDAY_9, bkk('2026-11-16T12:45:00'))
    expect(line.pushes.map((p) => p.to)).toEqual(['Ca'])
    await ticksBetween(bkk('2026-11-16T13:00:00'), bkk('2026-11-16T14:00:00'))
    expect(line.pushes.map((p) => p.to)).toEqual(['Ca', 'Cb'])
  })
})
