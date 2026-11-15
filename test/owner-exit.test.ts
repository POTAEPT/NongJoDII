import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DRIVE_CALL_MAX_MS, DRIVE_HARD_STOP_MS } from '@/server/google/drive-folders'
import { OWNER_EXIT_AFTER_DAYS, ownerExitJob } from '@/server/members/owner-left'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { makeTestDeps, seedOwnedGroup, TEST_NOW, tickRequest } from './harness'

// #30 part B through the tick seam: pg_cron's POST goes in at a fake time; LINE leave calls
// and the groups' left_at / delete_after marks come out. A group whose Owner left and that
// has no confirmed new Owner OWNER_EXIT_AFTER_DAYS later is left by the bot (botLeaveGroup,
// #11), which starts the 7-day deletion at once.

const DAY = 86_400_000
const at = (ms: number) => new Date(TEST_NOW.getTime() + ms)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  /** A set-up group whose Owner left at `ownerLeftAt` (no confirmed Owner since). */
  const ownerless = (lineGroupId: string, ownerLeftAt: Date) => {
    const g = seedOwnedGroup(h.store, { lineGroupId })
    const row = h.store.tables.groups.find((r) => r.id === g.id)!
    row.ownerConfirmedAt = null
    h.store.seedSchedule(g.id, { ownerLeftAt })
    return g
  }
  const tickAt = async (now: Date) => {
    h.setNow(now)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const marks = (groupId: string) => {
    const s = h.store.tables.group_schedules.find((r) => r.groupId === groupId)
    return { leftAt: s?.leftAt ?? null, deleteAfter: s?.deleteAfter ?? null }
  }
  return { ...h, ownerless, tickAt, marks }
}

describe('no new Owner 7 days after the Owner left (#30 part B)', () => {
  it('is in the tick', () => {
    expect(TICK_JOBS).toContain(ownerExitJob)
    expect(OWNER_EXIT_AFTER_DAYS).toBe(7)
  })

  it('the bot leaves the group on the first tick at 7 days, and the 7-day deletion starts at once', async () => {
    const t = setup()
    const g = t.ownerless('Cg1', TEST_NOW)
    await t.tickAt(at(7 * DAY - 15 * 60_000))
    expect(t.line.leaveCalls).toEqual([])
    const due = at(7 * DAY)
    await t.tickAt(due)
    expect(t.line.leaveCalls).toEqual(['Cg1'])
    expect(t.marks(g.id)).toEqual({ leftAt: due, deleteAfter: new Date(due.getTime() + 7 * DAY) })
    // Posts nothing to the group.
    expect(t.line.pushes).toEqual([])
  })

  it('leaves once: later ticks find the group marked', async () => {
    const t = setup()
    t.ownerless('Cg1', TEST_NOW)
    await t.tickAt(at(7 * DAY))
    await t.tickAt(at(7 * DAY + 15 * 60_000))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
  })

  it('a group with a confirmed new Owner stays', async () => {
    const t = setup()
    const g = t.ownerless('Cg1', TEST_NOW)
    // The new Owner confirmed (complete_owner_change clears owner_left_at).
    Object.assign(t.store.tables.groups.find((r) => r.id === g.id)!, { ownerConfirmedAt: at(DAY) })
    t.store.seedSchedule(g.id, { ownerLeftAt: null })
    await t.tickAt(at(8 * DAY))
    expect(t.line.leaveCalls).toEqual([])
  })

  it('a group with an Owner, or never set up, stays', async () => {
    const t = setup()
    seedOwnedGroup(t.store, { lineGroupId: 'Cowned' })
    t.store.seedGroup({ lineGroupId: 'Cnew' })
    await t.tickAt(at(30 * DAY))
    expect(t.line.leaveCalls).toEqual([])
  })

  it('a re-invite restarts the count: the bot leaves 7 days after the re-invite, not before', async () => {
    const t = setup()
    const g = t.ownerless('Cg1', TEST_NOW)
    const rejoin = at(5 * DAY)
    await t.store.markBotJoined({ groupId: g.id, at: rejoin })
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toEqual([])
    await t.tickAt(new Date(rejoin.getTime() + 7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
  })

  it('a LINE 5xx leaves the group unmarked, and the next tick tries again', async () => {
    const t = setup()
    const g = t.ownerless('Cg1', TEST_NOW)
    const other = t.ownerless('Cg2', at(-1000))
    t.line.failLeave = true
    await t.tickAt(at(7 * DAY))
    // One failure does not stop the others.
    expect(t.line.leaveCalls).toEqual(['Cg2', 'Cg1']) // oldest owner_left_at first
    expect(t.marks(g.id).leftAt).toBeNull()
    t.line.failLeave = false
    await t.tickAt(at(7 * DAY + 15 * 60_000))
    expect(t.marks(g.id).leftAt).toEqual(at(7 * DAY + 15 * 60_000))
    expect(t.marks(other.id).leftAt).toEqual(at(7 * DAY + 15 * 60_000))
  })

  it('the bot already out of the group (LINE 404) is marked all the same', async () => {
    const t = setup()
    const g = t.ownerless('Cg1', TEST_NOW)
    t.line.leaveNotInGroup = true
    await t.tickAt(at(7 * DAY))
    expect(t.marks(g.id).leftAt).toEqual(at(7 * DAY))
  })

  it('stops before a LINE call that could not end inside the tick, and the next tick goes on', async () => {
    const t = setup()
    for (let i = 0; i < 3; i++) t.ownerless(`Cg${i}`, at(-i))
    const now = at(7 * DAY)
    t.setNow(now)
    // Each LINE leave call takes 25 s. At 0 s and 25 s there is room for a call that runs to
    // its 10 s timeout before the 55 s hard stop; at 50 s there is not, so the third waits.
    t.line.leaveMs = 25_000
    await ownerExitJob.run(t.deps, now)
    expect(DRIVE_HARD_STOP_MS).toBe(55_000)
    expect(DRIVE_CALL_MAX_MS).toBe(10_000)
    expect(t.line.leaveCalls).toHaveLength(2)
    t.line.leaveMs = 0
    await t.tickAt(at(8 * DAY))
    expect(new Set(t.line.leaveCalls)).toEqual(new Set(['Cg0', 'Cg1', 'Cg2']))
  })
})
