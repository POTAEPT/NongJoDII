import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import type { LineEvent } from '@/server/line/types'
import { BOT_DELETE_AFTER_MS, botLeaveGroup } from '@/server/removal/leave'
import { PURGE_BATCH, PURGE_TIME, purgeJob } from '@/server/removal/purge'
import { stopUsing } from '@/server/settings/settings'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_NOW, tickRequest, webhookBody } from './harness'

// #11 Removal and recovery through the event seam (webhook and tick) and the Settings
// endpoint, with a fake clock: the bot leaves (Stop using, or by itself for #30), LINE
// removes it (leave event), a re-invite clears the mark, and the daily purge deletes only
// past-due groups. Drive is never touched.

const DAY = 86_400_000
const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const bkk = (s: string) => new Date(`${s}+07:00`)

let infos: MockInstance<typeof console.info>
beforeEach(() => {
  infos = vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})
const infoEvents = () => infos.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: [{ lineUserId: BIW, displayName: 'บิว' }] })
  h.line.idTokens.set('tok-owner', { lineUserId: OWNER, displayName: 'โอ๋' })
  h.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const tickAt = async (at: Date) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  /** groups.left_at, delete_after and owner_left_at of a group (null when unset). */
  const marks = (groupId = group.id) => {
    const s = h.store.tables.group_schedules.find((r) => r.groupId === groupId)
    return { leftAt: s?.leftAt ?? null, deleteAfter: s?.deleteAfter ?? null, ownerLeftAt: s?.ownerLeftAt ?? null }
  }
  const exists = (groupId = group.id) => h.store.tables.groups.some((g) => g.id === groupId)
  return { ...h, group, send, tickAt, marks, exists }
}

const at = (ms: number) => new Date(TEST_NOW.getTime() + ms)

describe('the leave event (#11)', () => {
  it('marks the group with a delete date 7 days after the event', async () => {
    const t = setup()
    const leftAt = at(60_000)
    await t.send(ev.leave({ timestamp: leftAt.getTime() }))
    expect(t.marks()).toMatchObject({ leftAt, deleteAfter: new Date(leftAt.getTime() + 7 * DAY) })
    expect(t.store.tables.webhook_events.map((w) => w.eventType)).toEqual(['leave'])
  })

  it('does not move the date when the same leave is delivered again, or a later one arrives', async () => {
    const t = setup()
    await t.send(ev.leave({ eventId: 'ev-leave', timestamp: TEST_NOW.getTime() }))
    const first = t.marks()
    await t.send(ev.leave({ eventId: 'ev-leave', timestamp: TEST_NOW.getTime(), redelivery: true }))
    await t.send(ev.leave({ timestamp: at(DAY).getTime() }))
    expect(t.marks()).toEqual(first)
  })

  it('for a group the bot never stored, adds no group row', async () => {
    const t = setup()
    await t.send(ev.leave({ groupId: 'Cunknown' }))
    expect(t.store.tables.groups.map((g) => g.lineGroupId)).toEqual(['Cgroup1'])
  })
})

describe('botLeaveGroup: the bot leaves by itself (#11, used by #30)', () => {
  it('sets the delete date as soon as LINE accepts, with no leave event', async () => {
    const t = setup()
    const now = at(5 * 60_000)
    const res = await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now })
    expect(t.line.leaveCalls).toEqual(['Cgroup1'])
    expect(res).toEqual({ outcome: 'left', deleteAfter: new Date(now.getTime() + BOT_DELETE_AFTER_MS) })
    expect(t.marks()).toMatchObject({ leftAt: now, deleteAfter: new Date(now.getTime() + 7 * DAY) })
  })

  it('a leave event arriving later does not move the date', async () => {
    const t = setup()
    const now = at(0)
    await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now })
    await t.send(ev.leave({ timestamp: at(30_000).getTime() }))
    expect(t.marks()).toMatchObject({ leftAt: now, deleteAfter: new Date(now.getTime() + 7 * DAY) })
  })

  it('a LINE error marks nothing and throws, so the caller can retry', async () => {
    const t = setup()
    t.line.failLeave = true
    await expect(botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now: at(0) })).rejects.toThrow()
    expect(t.marks()).toMatchObject({ leftAt: null, deleteAfter: null })
  })

  it('LINE 404 (the bot is no longer in the group) marks the group too, so a retry after a lost answer still starts the 7 days', async () => {
    const t = setup()
    t.line.leaveNotInGroup = true
    const now = at(0)
    expect(await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now }))
      .toEqual({ outcome: 'not_in_group', deleteAfter: new Date(now.getTime() + 7 * DAY) })
  })

  it('a group already marked keeps its date and LINE is not called again', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    const first = t.marks()
    const res = await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now: at(DAY) })
    expect(res).toEqual({ outcome: 'already_left', deleteAfter: first.deleteAfter })
    expect(t.line.leaveCalls).toEqual([])
    expect(t.marks()).toEqual(first)
  })

  it('an unknown group answers unknown_group and calls nothing', async () => {
    const t = setup()
    const res = await botLeaveGroup(t.deps, { groupId: '00000000-0000-4000-8000-000000000000', reason: 'no_owner', now: at(0) })
    expect(res).toEqual({ outcome: 'unknown_group', deleteAfter: null })
    expect(t.line.leaveCalls).toEqual([])
  })
})

describe('Stop using in Settings (#11)', () => {
  it('the confirmed Owner, after the confirm step, makes the bot leave; the 7 days start at once', async () => {
    const t = setup()
    const now = at(10 * 60_000)
    t.setNow(now)
    const res = await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true })
    expect(res).toEqual({ status: 200, body: { left: true, deleteAfter: new Date(now.getTime() + 7 * DAY).toISOString() } })
    expect(t.line.leaveCalls).toEqual(['Cgroup1'])
    expect(t.marks()).toMatchObject({ leftAt: now, deleteAfter: new Date(now.getTime() + 7 * DAY) })
    expect(infoEvents()).toContainEqual(expect.objectContaining({ event: 'bot_left_group', groupId: t.group.id, reason: 'stop_using' }))
  })

  it('without the confirm step nothing happens', async () => {
    const t = setup()
    const res = await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id })
    expect(res).toEqual({ status: 400, body: { error: 'bad_request', field: 'confirm' } })
    expect(t.line.leaveCalls).toEqual([])
  })

  it('a Member who is not the Owner is refused', async () => {
    const t = setup()
    const res = await stopUsing(t.deps, { idToken: 'tok-biw', groupId: t.group.id, confirm: true })
    expect(res).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect(t.line.leaveCalls).toEqual([])
    expect(t.marks().deleteAfter).toBeNull()
  })

  it('a bad ID token is refused', async () => {
    const t = setup()
    expect((await stopUsing(t.deps, { idToken: 'nope', groupId: t.group.id, confirm: true })).status).toBe(401)
    expect(t.line.leaveCalls).toEqual([])
  })

  it('a LINE failure answers 502 and marks nothing', async () => {
    const t = setup()
    t.line.failLeave = true
    expect(await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true }))
      .toEqual({ status: 502, body: { error: 'line_failed' } })
    expect(t.marks().deleteAfter).toBeNull()
  })
})

describe('Stop using: LINE accepted but nothing was marked (#11 review)', () => {
  it('a store failure after LINE accepted answers 502; the retry gets 404 and marks the group', async () => {
    const t = setup()
    t.store.failNext('markBotLeft')
    expect(await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true }))
      .toEqual({ status: 502, body: { error: 'line_failed' } })
    expect(t.marks().deleteAfter).toBeNull()
    t.line.leaveNotInGroup = true // the bot is already out
    const res = await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true })
    expect(res.status).toBe(200)
    expect((res.body as { deleteAfter: string | null }).deleteAfter).toBe(new Date(TEST_NOW.getTime() + 7 * DAY).toISOString())
    expect(t.marks().deleteAfter).toEqual(new Date(TEST_NOW.getTime() + 7 * DAY))
  })

  it('a mark that matched no row (deleteAfter null) is a failure, never 200 with no date', async () => {
    const t = setup()
    vi.spyOn(t.store, 'markBotLeft').mockResolvedValueOnce({ deleteAfter: null })
    await expect(botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'stop_using', now: TEST_NOW })).rejects.toThrow()
    vi.spyOn(t.store, 'markBotLeft').mockResolvedValueOnce({ deleteAfter: null })
    expect(await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true }))
      .toEqual({ status: 502, body: { error: 'line_failed' } })
  })

  it('Stop using in a Sub group leaves only that group: the main group and the Project stay', async () => {
    const t = setup()
    const project = t.store.seedProject(OWNER)
    const main = t.store.seedGroup({ lineGroupId: 'Cmain', projectId: project.id, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
    t.store.tables.group_setups.push({ groupId: main.id, isMain: true, featureSaveFiles: true, ownerNominatedByLineUserId: OWNER, ownerNominatedAt: TEST_NOW })
    const sub = t.store.tables.groups.find((g) => g.id === t.group.id)!
    sub.projectId = project.id
    const res = await stopUsing(t.deps, { idToken: 'tok-owner', groupId: t.group.id, confirm: true })
    expect(res.status).toBe(200)
    expect(t.line.leaveCalls).toEqual(['Cgroup1'])
    expect(t.marks().deleteAfter).not.toBeNull()
    expect(t.marks(main.id)).toMatchObject({ leftAt: null, deleteAfter: null })
    expect(t.store.tables.groups.find((g) => g.id === main.id)).toMatchObject({ projectId: project.id, ownerConfirmedAt: TEST_NOW })
    expect(t.store.tables.projects.find((p) => p.id === project.id)).toMatchObject({ ownerLineUserId: OWNER })
  })
})

describe('re-invite (#11)', () => {
  it('inside the 7 days clears the mark', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.send(ev.join({ timestamp: at(3 * DAY).getTime() }))
    expect(t.marks()).toMatchObject({ leftAt: null, deleteAfter: null })
    // and the purge after the old date leaves the group alone
    await t.tickAt(bkk(`2026-11-20T${PURGE_TIME}:00`))
    expect(t.exists()).toBe(true)
  })

  it('after the bot left by itself, a re-invite clears the mark too', async () => {
    const t = setup()
    await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'stop_using', now: at(0) })
    await t.send(ev.join({ timestamp: at(DAY).getTime() }))
    expect(t.marks()).toMatchObject({ leftAt: null, deleteAfter: null })
  })

  it('a stale leave delivered after the re-invite does not mark the group again', async () => {
    const t = setup()
    await t.send(ev.leave({ eventId: 'ev-old-leave', timestamp: TEST_NOW.getTime() }))
    await t.send(ev.join({ timestamp: at(DAY).getTime() }))
    await t.send(ev.leave({ eventId: 'ev-older-leave', timestamp: at(DAY - 60_000).getTime() }))
    expect(t.marks()).toMatchObject({ leftAt: null, deleteAfter: null })
  })

  it('to a group that still has no confirmed Owner restarts the 7-day Owner count', async () => {
    const t = setup()
    const ownerLeft = at(-8 * DAY)
    t.store.tables.groups[0].ownerConfirmedAt = null
    t.store.seedSchedule(t.group.id, { ownerLeftAt: ownerLeft })
    await botLeaveGroup(t.deps, { groupId: t.group.id, reason: 'no_owner', now: at(-DAY) })
    const rejoin = at(0)
    await t.send(ev.join({ timestamp: rejoin.getTime() }))
    expect(t.marks()).toEqual({ leftAt: null, deleteAfter: null, ownerLeftAt: rejoin })
  })

  it('to a group with a confirmed Owner, or one never set up, starts no Owner count', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.send(ev.join({ timestamp: at(DAY).getTime() }))
    expect(t.marks().ownerLeftAt).toBeNull()
    await t.send(ev.join({ groupId: 'Cnew', timestamp: at(DAY).getTime() }))
    const fresh = t.store.tables.groups.find((g) => g.lineGroupId === 'Cnew')!
    expect(t.marks(fresh.id).ownerLeftAt).toBeNull()
  })

  it('a purge by the tick between the join\'s lookup and its own purge still leaves a fresh group row', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    const realPurge = t.store.purgeGroup.bind(t.store)
    // The tick's purge deletes the row first, so the join's own purge finds nothing.
    vi.spyOn(t.store, 'purgeGroup').mockImplementationOnce(async (id, now) => {
      await realPurge(id, now)
      return { purged: false }
    })
    await t.send(ev.join({ timestamp: at(8 * DAY).getTime() }))
    const fresh = t.store.tables.groups.find((g) => g.lineGroupId === 'Cgroup1')
    expect(fresh).toBeDefined()
    expect(fresh!.id).not.toBe(t.group.id)
    expect(t.store.tables.group_schedules.find((s) => s.groupId === fresh!.id)?.joinedAt).toEqual(at(8 * DAY))
  })

  it('a leave stamped before the row was first stored still marks a group whose join was never applied', async () => {
    const t = setup()
    // The row came from a message (no join applied yet): joined_at is absent, not insert time.
    await t.send(ev.groupText({ text: 'สวัสดี', groupId: 'Cnew' }))
    const g = t.store.tables.groups.find((x) => x.lineGroupId === 'Cnew')!
    await t.send(ev.leave({ groupId: 'Cnew', timestamp: TEST_NOW.getTime() - 60_000 }))
    expect(t.marks(g.id).leftAt).toEqual(new Date(TEST_NOW.getTime() - 60_000))
  })

  it('after the delete date, the old data is purged at once and the group starts fresh', async () => {
    const t = setup()
    t.store.seedTask({ groupId: t.group.id, title: 'ทำสไลด์', createdByLineUserId: OWNER })
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.send(ev.join({ timestamp: at(8 * DAY).getTime() }))
    expect(t.exists()).toBe(false)
    const fresh = t.store.tables.groups.find((g) => g.lineGroupId === 'Cgroup1')!
    expect(fresh.ownerConfirmedAt).toBeNull()
    expect(t.marks(fresh.id)).toMatchObject({ leftAt: null, deleteAfter: null })
    expect(t.store.tables.tasks).toEqual([])
  })
})

describe('the daily purge (#11)', () => {
  function twoLeftGroups() {
    const t = setup()
    const other = seedOwnedGroup(t.store, { lineGroupId: 'Cgroup2', owner: 'Uowner2' })
    const live = seedOwnedGroup(t.store, { lineGroupId: 'Cgroup3', owner: 'Uowner3' })
    for (const g of [t.group, other, live]) {
      t.store.seedTask({ groupId: g.id, title: `งาน ${g.lineGroupId}`, createdByLineUserId: OWNER })
      t.store.seedAiUsage({ groupId: g.id })
    }
    return { t, other, live }
  }

  it('deletes only groups past their delete date, with their data; usage, push counts and event IDs stay', async () => {
    const { t, other, live } = twoLeftGroups()
    await t.send(ev.groupText({ text: 'สวัสดี', groupId: 'Cgroup1' }))
    await t.send(ev.leave({ groupId: 'Cgroup1', timestamp: TEST_NOW.getTime() }))
    await t.send(ev.leave({ groupId: 'Cgroup2', timestamp: at(3 * DAY).getTime() }))
    t.store.tables.push_log.push({ id: 'p1', purpose: 'reminder', lineTargetId: 'Cgroup1', messageCount: 2, sentAt: TEST_NOW })
    const events = t.store.tables.webhook_events.length

    await t.tickAt(bkk(`2026-11-19T${PURGE_TIME}:00`)) // 7 days after Cgroup1's leave (10:00) not reached yet
    expect(t.exists()).toBe(true)
    await t.tickAt(bkk(`2026-11-20T${PURGE_TIME}:00`))

    expect(t.exists()).toBe(false)
    expect(t.exists(other.id)).toBe(true)
    expect(t.exists(live.id)).toBe(true)
    expect(t.store.tables.tasks.map((x) => x.groupId).sort()).toEqual([other.id, live.id].sort())
    expect(t.store.tables.group_members.some((m) => m.groupId === t.group.id)).toBe(false)
    expect(t.store.tables.messages.some((m) => m.groupId === t.group.id)).toBe(false)
    expect(t.store.tables.group_schedules.some((s) => s.groupId === t.group.id)).toBe(false)
    expect(t.store.tables.ai_usage).toHaveLength(3)
    expect(t.store.tables.ai_usage.filter((u) => u.groupId === null)).toHaveLength(1)
    expect(t.store.tables.push_log).toHaveLength(1)
    expect(t.store.tables.webhook_events).toHaveLength(events)
    expect(infoEvents()).toContainEqual(expect.objectContaining({ event: 'purge_done', purged: 1, complete: true }))
  })

  it('never calls Google Drive: files stay in the Owner\'s Drive', async () => {
    const { t } = twoLeftGroups()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.tickAt(bkk(`2026-11-20T${PURGE_TIME}:00`))
    expect(t.exists()).toBe(false)
    expect(t.google.driveCalls).toEqual([])
    expect(t.google.refreshCalls).toEqual([])
  })

  it('runs once a Bangkok day: the other ticks of the day purge nothing', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.tickAt(bkk('2026-11-20T03:15:00'))
    await t.tickAt(bkk('2026-11-20T12:00:00'))
    expect(t.exists()).toBe(true)
    await t.tickAt(bkk(`2026-11-21T${PURGE_TIME}:00`))
    expect(t.exists()).toBe(false)
  })

  it('the slot is 03:00 to 03:14 Bangkok: 02:59 purges nothing, 03:14 still purges', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    await t.tickAt(bkk('2026-11-20T02:59:00'))
    expect(t.exists()).toBe(true)
    await t.tickAt(bkk('2026-11-20T03:14:00'))
    expect(t.exists()).toBe(false)
  })

  it('lists at most PURGE_BATCH groups a day; the rest go the next day', async () => {
    const t = setup()
    const due = new Date(TEST_NOW.getTime() - DAY)
    for (let i = 0; i < PURGE_BATCH + 5; i++) {
      const g = t.store.seedGroup({ lineGroupId: `Cbulk${i}` })
      t.store.tables.group_schedules.push({ groupId: g.id, leftAt: due, deleteAfter: due } as never)
    }
    const bulk = () => t.store.tables.groups.filter((g) => g.lineGroupId.startsWith('Cbulk')).length
    await t.tickAt(bkk(`2026-11-13T${PURGE_TIME}:00`))
    expect(bulk()).toBe(5)
    await t.tickAt(bkk(`2026-11-14T${PURGE_TIME}:00`))
    expect(bulk()).toBe(0)
  })

  it('is part of the tick, before the Drive finisher', () => {
    const names = TICK_JOBS.map((j) => j.name)
    expect(names).toContain(purgeJob.name)
    expect(names.indexOf(purgeJob.name)).toBeLessThan(names.indexOf('drive_setup'))
  })

  it('starts no delete once the tick has run out of time, and the next day finishes', async () => {
    const t = setup()
    await t.send(ev.leave({ timestamp: TEST_NOW.getTime() }))
    const slot = bkk(`2026-11-20T${PURGE_TIME}:00`)
    t.setNow(new Date(slot.getTime() + 60_000)) // the tick started 60 s ago
    await purgeJob.run(t.deps, slot)
    expect(t.exists()).toBe(true)
    expect(infoEvents()).toContainEqual(expect.objectContaining({ event: 'purge_done', purged: 0, complete: false }))
    await t.tickAt(bkk(`2026-11-21T${PURGE_TIME}:00`))
    expect(t.exists()).toBe(false)
  })

  it('one failed delete is logged and the next group still goes', async () => {
    const { t, other } = twoLeftGroups()
    await t.send(ev.leave({ groupId: 'Cgroup1', timestamp: TEST_NOW.getTime() }))
    await t.send(ev.leave({ groupId: 'Cgroup2', timestamp: TEST_NOW.getTime() }))
    t.store.failNext('purgeGroup')
    await t.tickAt(bkk(`2026-11-20T${PURGE_TIME}:00`))
    expect([t.exists(), t.exists(other.id)].filter(Boolean)).toHaveLength(1)
  })
})
