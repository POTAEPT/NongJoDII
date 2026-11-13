import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMINDER_TEXT } from '@/server/reminders/card'
import { REMINDER_PUSH_RESERVE } from '@/server/reminders/daily'
import { retryKeyFrom } from '@/server/line/push-budget'
import type { TaskRow } from '@/server/ports'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { FakeStore } from './fakes/fake-store'
import { makeTestDeps, seedOwnedGroup, tickRequest } from './harness'

// #44 (8b) through the tick seam: pg_cron's POST goes in; the group's reminder post (a LINE
// push), push_log rows and the claimed day come out. Bangkok wall-clock times; the default
// daily slot is 09:00. LINE's quota in the fake is 300 messages a month.

const bkk = (s: string) => new Date(`${s}+07:00`)
const QUARTER = 15 * 60_000
const MON_9 = bkk('2026-11-16T09:00:00') // a Monday: the weekly insight also runs at 09:00

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

/** A set-up group (5 people in LINE) with its weekly summary off, so every push is a reminder. */
function seedGroup(store: FakeStore, line: ReturnType<typeof setup>['line'], lineGroupId = 'Cgroup1') {
  const group = seedOwnedGroup(store, { lineGroupId, members: [{ lineUserId: 'Ubew', displayName: 'บิว' }] })
  store.seedSchedule(group.id, { featureWeeklySummary: false })
  line.groupMemberCounts.set(lineGroupId, 5)
  return group
}

/** A Task with its last activity set (seedTask cannot set it). */
function seedTask(store: FakeStore, p: Partial<TaskRow> & { groupId: string; title: string }, lastActivityAt = bkk('2026-11-15T12:00:00')) {
  const t = store.seedTask({ createdByLineUserId: 'Uowner1', status: 'in_process', assigneeLineUserId: 'Ubew', ...p })
  store.tables.tasks.find((r) => r.id === t.id)!.lastActivityAt = lastActivityAt
  return t
}

/** The Task titles in a reminder carousel (the first text of each bubble after the summary). */
function titlesIn(push: { messages: { type: string }[] }): string[] {
  const msg = push.messages[0] as { type: string; contents?: { contents?: unknown[] } }
  const bubbles = (msg.contents?.contents ?? []).slice(1) as Array<{ body: { contents: Array<{ text?: string }> } }>
  return bubbles.map((b) => b.body.contents[0].text ?? '')
}

const claimedOn = (store: FakeStore, groupId: string) =>
  store.tables.group_schedules.find((s) => s.groupId === groupId)?.dailyReminderLastSentOn ?? null

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('daily reminders (#44)', () => {
  it('posts once a day, on the first tick at or after the group\'s time, in the group', async () => {
    const { store, line, llm, ticksBetween } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'ส่งรายงาน', dueAt: bkk('2026-11-16T17:00:00') })

    await ticksBetween(bkk('2026-11-16T07:00:00'), bkk('2026-11-16T08:45:00'))
    expect(line.pushes).toHaveLength(0)

    await ticksBetween(MON_9, bkk('2026-11-16T23:45:00'))
    expect(line.pushes).toHaveLength(1)
    expect(line.pushes[0].to).toBe('Cgroup1')
    expect(line.pushes[0].messages[0]).toMatchObject({ type: 'flex', contents: { type: 'carousel' } })
    expect(titlesIn(line.pushes[0])).toEqual(['ส่งรายงาน'])
    expect(line.replies).toHaveLength(0)
    expect(llm.requests).toHaveLength(0)
    expect(claimedOn(store, group.id)).toBe('2026-11-16')
  })

  it('picks due today/tomorrow, overdue, no assignee and no update in 5 days; never Done or deleted', async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    const g = group.id
    seedTask(store, { groupId: g, title: 'quiet' })
    seedTask(store, { groupId: g, title: 'tomorrow', dueAt: bkk('2026-11-17T12:00:00') })
    seedTask(store, { groupId: g, title: 'next week', dueAt: bkk('2026-11-23T12:00:00') })
    seedTask(store, { groupId: g, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    seedTask(store, { groupId: g, title: 'unowned', status: 'not_assigned', assigneeLineUserId: null })
    seedTask(store, { groupId: g, title: 'silent' }, bkk('2026-11-10T12:00:00'))
    seedTask(store, { groupId: g, title: 'done late', status: 'done', dueAt: bkk('2026-11-14T12:00:00') })
    seedTask(store, { groupId: g, title: 'deleted late', dueAt: bkk('2026-11-14T12:00:00'), deletedAt: bkk('2026-11-15T12:00:00') })

    await tickAt(MON_9)
    expect(titlesIn(line.pushes[0])).toEqual(['late', 'tomorrow', 'unowned', 'silent'])
  })

  it('posts a Task again the next day while it still matches', async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    await tickAt(MON_9)
    await tickAt(bkk('2026-11-17T09:00:00'))
    expect(line.pushes.map(titlesIn)).toEqual([['late'], ['late']])
  })

  it('follows a time changed in Settings', async () => {
    const { store, line, ticksBetween } = setup()
    const group = seedGroup(store, line)
    store.seedSchedule(group.id, { dailyReminderTime: '13:30:00' })
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    await ticksBetween(MON_9, bkk('2026-11-16T13:15:00'))
    expect(line.pushes).toHaveLength(0)
    await ticksBetween(bkk('2026-11-16T13:30:00'), bkk('2026-11-16T15:00:00'))
    expect(line.pushes).toHaveLength(1)
  })

  it('sends nothing on a day with nothing to remind, and does not look again that day', async () => {
    const { store, line, ticksBetween } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'quiet' })
    await ticksBetween(MON_9, bkk('2026-11-16T10:00:00'))
    expect(line.pushes).toHaveLength(0)
    expect(store.tables.push_log).toHaveLength(0)
    expect(claimedOn(store, group.id)).toBe('2026-11-16')
  })

  it('counts every person in the LINE group, and sends a retry key per group and day', async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    const keys: Array<string | undefined> = []
    const push = line.push.bind(line)
    vi.spyOn(line, 'push').mockImplementation(async (to, messages, opts) => { keys.push(opts?.retryKey); return push(to, messages, opts) })
    await tickAt(MON_9)
    expect(store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'reminder', lineTargetId: 'Cgroup1', messageCount: 5 })])
    expect(keys).toEqual([retryKeyFrom(`reminder:${group.id}:2026-11-16`)])
  })

  it(`skips the post past ${100 - REMINDER_PUSH_RESERVE * 100}% of the quota, and does not retry it that day`, async () => {
    const { store, line, ticksBetween } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    line.quota = { limit: 300, used: 290 } // 290 + 5 > 294
    await ticksBetween(MON_9, bkk('2026-11-16T10:00:00'))
    expect(line.pushes).toHaveLength(0)
    expect(store.tables.push_log).toHaveLength(0)
    expect(claimedOn(store, group.id)).toBe('2026-11-16')
  })

  it('retries on the next tick when the post fails (a LINE 5xx), with the same retry key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    const keys: Array<string | undefined> = []
    const push = line.push.bind(line)
    vi.spyOn(line, 'push').mockImplementation(async (to, messages, opts) => { keys.push(opts?.retryKey); return push(to, messages, opts) })

    line.failPush = true
    await tickAt(MON_9)
    expect(claimedOn(store, group.id)).toBeNull() // released
    // A LINE 5xx leaves the outcome unknown (the push may have been delivered), so the
    // budget claim stays; only a push LINE refused (4xx) gives it back.
    expect(store.tables.push_log).toHaveLength(1)
    expect(errors.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toContain('group_push_failed')

    line.failPush = false
    await tickAt(bkk('2026-11-16T09:15:00'))
    expect(line.pushes).toHaveLength(2) // the failed attempt and the retry
    expect(keys[0]).toBe(keys[1])
    expect(claimedOn(store, group.id)).toBe('2026-11-16')
  })

  it('retries on the next tick when reading the Tasks fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    store.failNext('listReminderTasks')
    await tickAt(MON_9)
    expect(line.pushes).toHaveLength(0)
    await tickAt(bkk('2026-11-16T09:15:00'))
    expect(line.pushes).toHaveLength(1)
  })

  it('skips groups not set up, groups the bot left, and groups with reminders off', async () => {
    const { store, line, tickAt } = setup()
    const notSetUp = store.seedGroup({ lineGroupId: 'Cnew' })
    const left = seedGroup(store, line, 'Cleft')
    store.seedSchedule(left.id, { leftAt: bkk('2026-11-14T10:00:00') })
    const off = seedGroup(store, line, 'Coff')
    store.tables.groups.find((g) => g.id === off.id)!.featureTrackRemind = false
    const on = seedGroup(store, line, 'Con')
    for (const g of [notSetUp, left, off, on]) seedTask(store, { groupId: g.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })

    await tickAt(MON_9)
    expect(line.pushes.map((p) => p.to)).toEqual(['Con'])
  })

  it('serves several groups at their own times over several days', async () => {
    const { store, line, ticksBetween } = setup()
    const a = seedGroup(store, line, 'Ca')
    const b = seedGroup(store, line, 'Cb')
    store.seedSchedule(b.id, { dailyReminderTime: '18:00:00' })
    for (const g of [a, b]) seedTask(store, { groupId: g.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    await ticksBetween(MON_9, bkk('2026-11-17T23:45:00')) // Monday 09:00 to Tuesday night
    expect(line.pushes.map((p) => p.to)).toEqual(['Ca', 'Cb', 'Ca', 'Cb'])
  })

  it('goes before the weekly post and keeps a smaller reserve, so it still goes out when the weekly one is skipped', async () => {
    const { store, line, tickAt } = setup()
    const group = seedGroup(store, line)
    store.seedSchedule(group.id, { featureWeeklySummary: true })
    seedTask(store, { groupId: group.id, title: 'late', dueAt: bkk('2026-11-14T12:00:00') })
    line.quota = { limit: 300, used: 265 }
    // Reminder: 265 + 5 = 270 <= 294 sent. Weekly: 265 + 5 (+5 recent) = 275 > 270 skipped.
    await tickAt(MON_9)
    expect(line.pushes).toHaveLength(1)
    expect((line.pushes[0].messages[0] as { altText: string }).altText.startsWith(REMINDER_TEXT.title)).toBe(true)
    expect(store.tables.weekly_insights.find((w) => w.groupId === group.id)?.postedAt).toBeNull()
  })
})
