import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNOWNED_LIST_LIMIT, buildWeeklyInsight } from '@/server/insight/weekly'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { FakeStore } from './fakes/fake-store'
import { makeTestDeps, seedOwnedGroup, tickRequest } from './harness'

// #20 through the tick seam: pg_cron's POST goes in, weekly_insights rows and the
// groups' last-sent dates come out. Bangkok wall-clock times throughout.

const bkk = (s: string) => new Date(`${s}+07:00`)
const QUARTER = 15 * 60_000

function setup() {
  const h = makeTestDeps()
  /** One pg_cron tick at `at`, run to the end (the route answers, then after() runs). */
  const tickAt = async (at: Date) => {
    h.setNow(at)
    const res = await handleTickRequest(tickRequest(), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  /** Every 15-minute tick from `from` to `to`, both included. */
  const ticksBetween = async (from: Date, to: Date) => {
    for (let t = from.getTime(); t <= to.getTime(); t += QUARTER) await tickAt(new Date(t))
  }
  return { ...h, tickAt, ticksBetween }
}

/** 2 Done, 1 In Process, 3 Not Assigned, plus a deleted Not Assigned one that must not count. */
function seedTasks(store: FakeStore, groupId: string) {
  const base = { groupId, createdByLineUserId: 'Uowner1' }
  store.seedTask({ ...base, title: 'Logo', status: 'done', assigneeLineUserId: 'Uowner1' })
  store.seedTask({ ...base, title: 'Poster', status: 'done', assigneeLineUserId: 'Uowner1' })
  store.seedTask({ ...base, title: 'Slides', status: 'in_process', assigneeLineUserId: 'Uowner1' })
  store.seedTask({ ...base, title: 'Budget', status: 'not_assigned' })
  store.seedTask({ ...base, title: 'Venue', status: 'not_assigned', dueAt: bkk('2026-11-20T17:00:00') })
  store.seedTask({ ...base, title: 'Catering', status: 'not_assigned' })
  store.seedTask({ ...base, title: 'Old idea', status: 'not_assigned', deletedAt: bkk('2026-11-10T10:00:00') })
}

const insightsOf = (store: FakeStore, groupId: string) =>
  store.tables.weekly_insights.filter((w) => w.groupId === groupId)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('weekly insight (#20)', () => {
  it('saves one insight on the first tick at Monday 09:00 (default), with counts from live Tasks', async () => {
    const { store, ticksBetween, tickAt } = setup()
    const group = seedOwnedGroup(store)
    seedTasks(store, group.id)

    await ticksBetween(bkk('2026-11-16T08:00:00'), bkk('2026-11-16T08:45:00'))
    expect(insightsOf(store, group.id)).toHaveLength(0)

    await tickAt(bkk('2026-11-16T09:00:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
    expect(insightsOf(store, group.id)[0]).toMatchObject({
      weekStart: '2026-11-16',
      counts: { done: 2, inProcess: 1, awaitingOwner: 3 },
      createdAt: bkk('2026-11-16T09:00:00'),
    })

    // The rest of Monday adds nothing.
    await ticksBetween(bkk('2026-11-16T09:15:00'), bkk('2026-11-16T23:45:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
  })

  it('does nothing on the other days of the week', async () => {
    const { store, ticksBetween } = setup()
    const group = seedOwnedGroup(store)
    await ticksBetween(bkk('2026-11-17T00:00:00'), bkk('2026-11-17T23:45:00')) // Tuesday
    expect(insightsOf(store, group.id)).toHaveLength(0)
  })

  it('follows a non-default day and time (Friday 16:30)', async () => {
    const { store, ticksBetween } = setup()
    const group = seedOwnedGroup(store)
    store.seedSchedule(group.id, { weeklySummaryWeekday: 5, weeklySummaryTime: '16:30:00' })

    await ticksBetween(bkk('2026-11-16T09:00:00'), bkk('2026-11-16T09:15:00')) // Monday 09:00 is not its slot
    await ticksBetween(bkk('2026-11-20T16:00:00'), bkk('2026-11-20T16:15:00'))
    expect(insightsOf(store, group.id)).toHaveLength(0)

    await ticksBetween(bkk('2026-11-20T16:30:00'), bkk('2026-11-20T17:30:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
    expect(insightsOf(store, group.id)[0].weekStart).toBe('2026-11-16')
  })

  it('serves several groups at their own times in the same run of ticks', async () => {
    const { store, ticksBetween } = setup()
    const monday9 = seedOwnedGroup(store, { lineGroupId: 'Cmon' })
    const monday13 = seedOwnedGroup(store, { lineGroupId: 'Cmon13' })
    store.seedSchedule(monday13.id, { weeklySummaryTime: '13:15:00' })

    await ticksBetween(bkk('2026-11-16T09:00:00'), bkk('2026-11-16T13:00:00'))
    expect(insightsOf(store, monday9.id)).toHaveLength(1)
    expect(insightsOf(store, monday13.id)).toHaveLength(0)

    await ticksBetween(bkk('2026-11-16T13:15:00'), bkk('2026-11-16T14:00:00'))
    expect(insightsOf(store, monday9.id)).toHaveLength(1)
    expect(insightsOf(store, monday13.id)).toHaveLength(1)
  })

  it('saves one insight per group per week, and a new one the next week', async () => {
    const { store, tickAt } = setup()
    const group = seedOwnedGroup(store)
    await tickAt(bkk('2026-11-16T09:00:00'))
    await tickAt(bkk('2026-11-23T09:00:00'))
    expect(insightsOf(store, group.id).map((w) => w.weekStart)).toEqual(['2026-11-16', '2026-11-23'])
  })

  it('keeps one insight per week when the day is moved later in Settings after this week\'s', async () => {
    const { store, tickAt } = setup()
    const group = seedOwnedGroup(store)
    await tickAt(bkk('2026-11-16T09:00:00')) // Monday: saved
    store.seedSchedule(group.id, { weeklySummaryWeekday: 3 }) // moved to Wednesday
    await tickAt(bkk('2026-11-18T09:00:00')) // same week: no second one
    expect(insightsOf(store, group.id)).toHaveLength(1)
    await tickAt(bkk('2026-11-25T09:00:00')) // next Wednesday
    expect(insightsOf(store, group.id).map((w) => w.weekStart)).toEqual(['2026-11-16', '2026-11-23'])
  })

  it('skips groups that are not set up, that the bot left, or that turned the weekly summary off', async () => {
    const { store, tickAt } = setup()
    const notSetUp = store.seedGroup({ lineGroupId: 'Cnew' }) // no Project yet
    const left = seedOwnedGroup(store, { lineGroupId: 'Cleft' })
    store.seedSchedule(left.id, { leftAt: bkk('2026-11-14T10:00:00') })
    const off = seedOwnedGroup(store, { lineGroupId: 'Coff' })
    store.seedSchedule(off.id, { featureWeeklySummary: false })
    const on = seedOwnedGroup(store, { lineGroupId: 'Con' })

    await tickAt(bkk('2026-11-16T09:00:00'))
    expect(store.tables.weekly_insights.map((w) => w.groupId)).toEqual([on.id])
    expect(insightsOf(store, notSetUp.id)).toHaveLength(0)
  })

  it('two ticks that really overlap still save one insight', async () => {
    const { store, deps, defer, deferred, setNow } = setup()
    const group = seedOwnedGroup(store)
    setNow(bkk('2026-11-16T09:00:00'))
    await handleTickRequest(tickRequest(), deps, defer)
    await handleTickRequest(tickRequest(), deps, defer)
    expect(deferred).toHaveLength(2)

    // Pause the first run right after its claim (its first count), so the second run
    // works while the first is still unfinished.
    let open!: () => void
    const gate = new Promise<void>((resolve) => { open = resolve })
    const count = store.countTasksByStatus.bind(store)
    let counts = 0
    vi.spyOn(store, 'countTasksByStatus').mockImplementation(async (groupId) => {
      counts += 1
      if (counts === 1) await gate
      return count(groupId)
    })

    const both = Promise.all(deferred.splice(0).map((job) => job()))
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the second run go as far as it can
    open()
    await both

    // Either the claim stopped the second run, or the second run got past it and the
    // unique (group_id, week_start) kept the row single. Both paths end with one row.
    expect(insightsOf(store, group.id)).toHaveLength(1)
    expect(store.tables.group_schedules.find((s) => s.groupId === group.id)?.weeklySummaryLastSentOn).toBe('2026-11-16')
  })

  it('recovers later the same day when both the save and the release fail', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, tickAt } = setup()
    const group = seedOwnedGroup(store)
    store.failNext('saveWeeklyInsight')
    store.failNext('releaseWeeklySummary')

    await tickAt(bkk('2026-11-16T09:00:00'))
    expect(insightsOf(store, group.id)).toHaveLength(0)
    // The claim is stuck on today, with no row for the week.
    expect(store.tables.group_schedules.find((s) => s.groupId === group.id)?.weeklySummaryLastSentOn).toBe('2026-11-16')
    const events = errors.mock.calls.map((c) => JSON.parse(String(c[0])).event)
    expect(events).toEqual(['weekly_insight_release_failed', 'weekly_insight_failed'])

    await tickAt(bkk('2026-11-16T09:15:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
    expect(insightsOf(store, group.id)[0].weekStart).toBe('2026-11-16')

    await tickAt(bkk('2026-11-16T09:30:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
  })

  it('retries on the next tick when saving fails, and other groups are not held up', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, tickAt } = setup()
    const first = seedOwnedGroup(store, { lineGroupId: 'Cfirst' })
    const second = seedOwnedGroup(store, { lineGroupId: 'Csecond' })
    const [failing, other] = [first, second].sort((a, b) => a.id.localeCompare(b.id)) // the order groups are served
    store.failNext('saveWeeklyInsight')

    await tickAt(bkk('2026-11-16T09:00:00'))
    expect(insightsOf(store, failing.id)).toHaveLength(0)
    expect(insightsOf(store, other.id)).toHaveLength(1)
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({ event: 'weekly_insight_failed', groupId: failing.id })

    await tickAt(bkk('2026-11-16T09:15:00'))
    expect(insightsOf(store, failing.id)).toHaveLength(1)
    expect(insightsOf(store, other.id)).toHaveLength(1)
  })

  it('makes no AI call (the group post itself is covered in weekly-post.test.ts)', async () => {
    const { store, llm, line, tickAt } = setup()
    const group = seedOwnedGroup(store)
    seedTasks(store, group.id)
    await tickAt(bkk('2026-11-16T09:00:00'))
    expect(insightsOf(store, group.id)).toHaveLength(1)
    expect(llm.requests).toHaveLength(0)
    expect(line.replies).toHaveLength(0)
  })
})

describe('buildWeeklyInsight (#20, read by #21)', () => {
  it('lists the live unowned Tasks, oldest first, and the same counts', async () => {
    const { store, deps } = setup()
    const group = seedOwnedGroup(store)
    seedTasks(store, group.id)
    const [row] = await store.listWeeklySummaryGroups(1)
    const insight = await buildWeeklyInsight(deps, row, bkk('2026-11-18T09:00:00'))
    expect(insight.weekStart).toBe('2026-11-16')
    expect(insight.lineGroupId).toBe(group.lineGroupId)
    expect(insight.counts).toEqual({ done: 2, inProcess: 1, awaitingOwner: 3 })
    expect(insight.unowned.map((t) => t.title)).toEqual(['Budget', 'Venue', 'Catering'])
    expect(insight.unowned[1].dueAt).toEqual(bkk('2026-11-20T17:00:00'))
  })

  it(`lists at most ${UNOWNED_LIST_LIMIT} unowned Tasks`, async () => {
    const { store, deps } = setup()
    const group = seedOwnedGroup(store)
    for (let i = 1; i <= UNOWNED_LIST_LIMIT + 3; i++) {
      store.seedTask({ groupId: group.id, title: `Task ${i}`, createdByLineUserId: 'Uowner1' })
    }
    const [row] = await store.listWeeklySummaryGroups(1)
    const insight = await buildWeeklyInsight(deps, row, bkk('2026-11-16T09:00:00'))
    expect(insight.counts.awaitingOwner).toBe(UNOWNED_LIST_LIMIT + 3)
    expect(insight.unowned).toHaveLength(UNOWNED_LIST_LIMIT)
    expect(insight.unowned[0].title).toBe('Task 1')
  })
})
