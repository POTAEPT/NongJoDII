import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import { handleTickRequest } from '@/server/tick/handle-request'
import { makeTestDeps, seedOwnedGroup, tickRequest } from './harness'

// #22 (10c) Insight on the Dashboard, through the tick seam (the weekly job saves the insight
// and tries to post it) and the Dashboard read seam. LINE's quota in the fake is 300 a month.

const bkk = (s: string) => new Date(`${s}+07:00`)
const MONDAY_9 = bkk('2026-11-16T09:00:00')
const OWNER = 'Uowner1'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  const group = seedOwnedGroup(h.store)
  const row = h.store.tables.groups.find((g) => g.id === group.id)!
  row.projectId = h.store.seedProject(OWNER).id // the Dashboard reads the Project's row
  row.featureTrackRemind = false // only the weekly post pushes
  h.line.groupMemberCounts.set('Cgroup1', 5)
  h.line.idTokens.set('tok-owner', { lineUserId: OWNER, displayName: 'Owner' })
  const base = { groupId: group.id, createdByLineUserId: OWNER }
  h.store.seedTask({ ...base, title: 'Logo', status: 'done', assigneeLineUserId: OWNER })
  h.store.seedTask({ ...base, title: 'Slides', status: 'in_process', assigneeLineUserId: OWNER })
  h.store.seedTask({ ...base, title: 'Budget', status: 'not_assigned' })
  const tickAt = async (at: Date) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const insight = async () => {
    const res = await loadDashboard(h.deps, { idToken: 'tok-owner' })
    expect(res.status).toBe(200)
    return (res.body as DashboardData).groups.find((g) => g.groupId === group.id)!.insight
  }
  return { ...h, group, tickAt, insight }
}

describe('insight on the Dashboard (#22)', () => {
  it('shows the latest insight of a group with its counts once the weekly job saved it', async () => {
    const t = setup()
    await t.tickAt(MONDAY_9)
    expect(t.line.pushes).toHaveLength(1)
    expect(await t.insight()).toEqual({ weekStart: '2026-11-16', done: 1, inProcess: 1, awaitingOwner: 1, posted: true })
  })

  it('an insight not pushed near the LINE limit still shows, marked as not posted', async () => {
    const t = setup()
    t.line.quota = { limit: 300, used: 266 } // 266 + 5 people > 90% of 300
    await t.tickAt(MONDAY_9)
    expect(t.line.pushes).toHaveLength(0)
    expect(await t.insight()).toEqual({ weekStart: '2026-11-16', done: 1, inProcess: 1, awaitingOwner: 1, posted: false })
  })

  it('shows the newest week when there are several', async () => {
    const t = setup()
    await t.tickAt(MONDAY_9)
    t.store.seedTask({ groupId: t.group.id, createdByLineUserId: OWNER, title: 'Poster', status: 'done', assigneeLineUserId: OWNER })
    await t.tickAt(bkk('2026-11-23T09:00:00'))
    expect(await t.insight()).toMatchObject({ weekStart: '2026-11-23', done: 2 })
  })

  it('is null before the first weekly insight', async () => {
    const t = setup()
    expect(await t.insight()).toBeNull()
  })
})
