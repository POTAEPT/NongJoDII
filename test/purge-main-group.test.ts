import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_NEEDED_TEXT } from '@/server/members/owner-left'
import { PURGE_TIME, purgeJob } from '@/server/removal/purge'
import { stopUsing } from '@/server/settings/settings'
import { DELETE_NOW_PHRASE } from '@/server/settings/types'
import { makeTestDeps, TEST_NOW } from './harness'

// #77: purging a Project's main group (the daily purge, or Stop using with delete now)
// detaches the Project's other groups (a fresh 7-day Owner count, the owner_needed card in
// each group the bot is still in), and deletes the Project row once no group and no saved
// file points at it. Drive is never called.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const OWNER = 'Uowner1'
const DAY = 86_400_000
const bkk = (iso: string) => new Date(`${iso}+07:00`)

function setup(subGroups: number) {
  const h = makeTestDeps()
  const project = h.store.seedProject(OWNER)
  const group = (lineGroupId: string, isMain: boolean) => {
    const g = h.store.seedGroup({ lineGroupId, name: lineGroupId, projectId: project.id, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
    h.store.tables.group_setups.push({ groupId: g.id, isMain, featureSaveFiles: true, ownerNominatedByLineUserId: OWNER, ownerNominatedAt: TEST_NOW })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner' })
    h.line.groupMemberCounts.set(lineGroupId, 2)
    return g
  }
  const main = group('Cmain', true)
  const subs = Array.from({ length: subGroups }, (_, i) => group(`Csub${i + 1}`, false))
  // The bot left the main group 8 days ago: its delete date has passed.
  h.store.seedSchedule(main.id, { leftAt: new Date(TEST_NOW.getTime() - 8 * DAY), deleteAfter: new Date(TEST_NOW.getTime() - DAY) })
  const row = (id: string) => h.store.tables.groups.find((g) => g.id === id)
  const projectRow = () => h.store.tables.projects.find((p) => p.id === project.id)
  const ownerNeededPushes = () => h.line.pushes.filter((p) => JSON.stringify(p.messages).includes(OWNER_NEEDED_TEXT.title)).map((p) => p.to)
  const purgeNow = async () => {
    const at = bkk(`2026-11-20T${PURGE_TIME}:00`)
    h.setNow(at)
    await purgeJob.run(h.deps, at)
  }
  return { ...h, project, main, subs, row, projectRow, ownerNeededPushes, purgeNow }
}

describe('purge of a main group (#77)', () => {
  it('with no Sub group: the group and its Project row go', async () => {
    const s = setup(0)
    await s.purgeNow()
    expect(s.row(s.main.id)).toBeUndefined()
    expect(s.projectRow()).toBeUndefined()
    expect(s.line.pushes).toEqual([])
  })

  it('with one Sub group: it detaches, starts a 7-day Owner count, and gets the owner_needed card', async () => {
    const s = setup(1)
    await s.purgeNow()
    const sub = s.row(s.subs[0].id)!
    expect(sub).toMatchObject({ projectId: null, ownerConfirmedAt: null, nominatedOwnerLineUserId: null })
    expect(sub.ownerLeftAt).toEqual(s.deps.now())
    expect(s.projectRow()).toBeUndefined()
    expect(s.ownerNeededPushes()).toEqual(['Csub1'])
  })

  it('with two Sub groups: both detach and each gets one card; the Sub group the bot left gets none', async () => {
    const s = setup(2)
    const later = bkk('2026-11-26T10:00:00') // after this purge run
    s.store.seedSchedule(s.subs[1].id, { leftAt: TEST_NOW, deleteAfter: later })
    await s.purgeNow()
    expect(s.subs.map((g) => s.row(g.id)?.projectId)).toEqual([null, null])
    expect(s.ownerNeededPushes()).toEqual(['Csub1'])
    // The left Sub group keeps its own delete date and is purged on it.
    expect(s.store.tables.group_schedules.find((r) => r.groupId === s.subs[1].id)?.deleteAfter).toEqual(later)
  })

  it('a Sub group re-invited before the purge ran is detached like any live one', async () => {
    const s = setup(1)
    s.store.seedSchedule(s.subs[0].id, { leftAt: null, deleteAfter: null, joinedAt: TEST_NOW })
    await s.purgeNow()
    expect(s.row(s.subs[0].id)?.projectId).toBeNull()
    expect(s.ownerNeededPushes()).toEqual(['Csub1'])
  })

  it('a Sub group holding files saved through the Project\'s Drive keeps the Project row and its Drive history', async () => {
    const s = setup(1)
    const connectionId = randomUUID()
    s.store.tables.drive_connections.push({ id: connectionId, projectId: s.project.id, googleAccountId: randomUUID(), status: 'active' })
    const file = s.store.seedFile({ groupId: s.subs[0].id, messageId: null, fileName: 'a.pdf', driveLink: 'https://drive/a' })
    file.driveConnectionId = connectionId
    s.store.tables.files.find((f) => f.id === file.id)!.driveConnectionId = connectionId
    await s.purgeNow()
    expect(s.row(s.subs[0].id)?.projectId).toBeNull()
    expect(s.projectRow()).toBeDefined()
    expect(s.store.tables.drive_connections.some((c) => c.id === connectionId)).toBe(true)
    expect(s.store.tables.files.some((f) => f.id === file.id)).toBe(true)
  })

  it('a Sub group itself purged leaves its Project and the main group alone', async () => {
    const s = setup(1)
    s.store.seedSchedule(s.main.id, { leftAt: null, deleteAfter: null })
    s.store.seedSchedule(s.subs[0].id, { leftAt: new Date(TEST_NOW.getTime() - 8 * DAY), deleteAfter: new Date(TEST_NOW.getTime() - DAY) })
    await s.purgeNow()
    expect(s.row(s.subs[0].id)).toBeUndefined()
    expect(s.row(s.main.id)?.projectId).toBe(s.project.id)
    expect(s.projectRow()).toBeDefined()
    expect(s.line.pushes).toEqual([])
  })
})

describe('Stop using with delete now on a main group (#147 + #77)', () => {
  it('detaches its Sub groups and posts their owner_needed card', async () => {
    const s = setup(1)
    s.store.seedSchedule(s.main.id, { leftAt: null, deleteAfter: null })
    s.line.idTokens.set('tok-owner', { lineUserId: OWNER, displayName: 'Owner' })
    const res = await stopUsing(s.deps, { idToken: 'tok-owner', groupId: s.main.id, confirm: true, deleteNow: true, confirmText: DELETE_NOW_PHRASE })
    expect(res.body).toMatchObject({ left: true, deleted: true })
    expect(s.row(s.subs[0].id)?.projectId).toBeNull()
    expect(s.ownerNeededPushes()).toEqual(['Csub1'])
    expect(s.projectRow()).toBeUndefined()
  })
})
