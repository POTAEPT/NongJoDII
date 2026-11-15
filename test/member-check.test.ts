import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_CHECK_TIME, memberCheckJob } from '@/server/members/daily-check'
import { MEMBER_LEFT_TEXT } from '@/server/members/card'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, tickRequest, webhookBody } from './harness'

// #32 through the event seam: scheduled ticks go in with a fake clock; LINE's group member
// profile answers 200 (in the group), 404 (gone) or an error; membership rows, Task rows and
// group pushes come out. A 404 runs the same leave as a memberLeft webhook (#29).

const BIW = 'Uzbiw' // asked last: Members are asked in user ID order
const TON = 'Uton'
const OWNER = 'Uowner1'
const LINE_GROUP = 'Cgroup1'
const MIN = 60_000
const DAY = 24 * 60 * MIN
/** 08:00 in Bangkok on 2026-11-12: the check's slot. */
const SLOT = new Date('2026-11-12T01:00:00Z')

function setup() {
  const h = makeTestDeps({ now: SLOT })
  h.store.pushClock = () => h.deps.now()
  const group = seedOwnedGroup(h.store, {
    members: [{ lineUserId: TON, displayName: 'ต้น' }, { lineUserId: BIW, displayName: 'บิว' }],
  })
  h.line.groupNames.set(LINE_GROUP, 'ทีมโปสเตอร์') // the bot is in the group
  h.line.groupMemberCounts.set(LINE_GROUP, 3)
  for (const u of [OWNER, TON, BIW]) h.line.profiles.set(`${LINE_GROUP}:${u}`, u)
  const base = { groupId: group.id, createdByLineUserId: OWNER }
  const slides = h.store.seedTask({ ...base, title: 'ทำสไลด์', status: 'in_process', assigneeLineUserId: BIW })
  const logo = h.store.seedTask({ ...base, title: 'ทำโลโก้', status: 'done', assigneeLineUserId: BIW })
  const tick = async (at: Date, jobs = [memberCheckJob]) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, jobs)).status).toBe(200)
    await h.runDeferred()
  }
  /** Biw left the group, and LINE's leave event never came. */
  const biwLeaves = () => h.line.profiles.delete(`${LINE_GROUP}:${BIW}`)
  const member = (u: string) => h.store.tables.group_members.find((m) => m.groupId === group.id && m.lineUserId === u)!
  const task = (id: string) => h.store.tables.tasks.find((t) => t.id === id)!
  const leaveCards = () => h.line.delivered.filter((p) => JSON.stringify(p.messages).includes(MEMBER_LEFT_TEXT.title(['บิว'])))
  const checked = (u: string) => h.line.profileCalls.filter((c) => c.lineUserId === u).length
  return { ...h, group, slides, logo, tick, biwLeaves, member, task, leaveCards, checked }
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('daily member check (#32)', () => {
  it('runs with the default tick jobs', async () => {
    const t = setup()
    t.biwLeaves()
    await t.tick(SLOT, TICK_JOBS)
    expect(t.member(BIW).leftAt).not.toBeNull()
    expect(t.leaveCards()).toHaveLength(1)
    expect(MEMBER_CHECK_TIME).toBe('08:00')
  })

  it('checks each live Member of the group with LINE; a profile reply changes nothing', async () => {
    const t = setup()
    await t.tick(SLOT)
    expect(t.line.profileCalls.map((c) => c.lineUserId).sort()).toEqual([BIW, OWNER, TON].sort())
    expect(t.line.profileCalls.every((c) => c.lineGroupId === LINE_GROUP)).toBe(true)
    expect(t.member(BIW).leftAt).toBeNull()
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: BIW, status: 'in_process' })
    expect(t.line.pushes).toEqual([])
  })

  it('a 404 marks the person as left, releases their open Tasks and posts one leave card', async () => {
    const t = setup()
    t.biwLeaves()
    await t.tick(SLOT)
    expect(t.member(BIW).leftAt).not.toBeNull()
    expect(t.member(TON).leftAt).toBeNull()
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
    expect(t.task(t.logo.id)).toMatchObject({ assigneeLineUserId: BIW, status: 'done' }) // Done keeps the name
    expect(t.leaveCards()).toHaveLength(1)
    expect(t.leaveCards()[0].to).toBe(LINE_GROUP)
    expect(JSON.stringify(t.leaveCards()[0].messages)).toContain('ทำสไลด์')
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a 404 followed by the late leave event gives one card, not two', async () => {
    const t = setup()
    t.biwLeaves()
    await t.tick(SLOT)
    // LINE's leave event finally arrives, stamped before the check ran.
    const late = ev.memberLeft({ userIds: [BIW], timestamp: SLOT.getTime() - 30 * MIN })
    expect((await handleWebhookRequest(signedRequest(webhookBody(late)), t.deps, t.defer)).status).toBe(200)
    await t.runDeferred()
    expect(t.leaveCards()).toHaveLength(1)
    expect(t.member(BIW).leftAt).not.toBeNull()
  })

  it('a Member whose leave event already arrived is not checked or handled again', async () => {
    const t = setup()
    t.biwLeaves()
    const leave = ev.memberLeft({ userIds: [BIW], timestamp: SLOT.getTime() - 30 * MIN })
    expect((await handleWebhookRequest(signedRequest(webhookBody(leave)), t.deps, t.defer)).status).toBe(200)
    await t.runDeferred()
    expect(t.leaveCards()).toHaveLength(1)
    await t.tick(SLOT)
    expect(t.checked(BIW)).toBe(0)
    expect(t.leaveCards()).toHaveLength(1)
  })

  it('an error other than 404 marks nobody, and the next day\'s run checks again', async () => {
    const t = setup()
    t.biwLeaves()
    t.line.failProfileFor.add(`${LINE_GROUP}:${BIW}`)
    await t.tick(SLOT)
    expect(t.member(BIW).leftAt).toBeNull()
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: BIW })
    expect(t.line.pushes).toEqual([])
    // The other Members were still checked, and later ticks that day do not retry.
    expect(t.checked(TON)).toBe(1)
    await t.tick(new Date(SLOT.getTime() + 15 * MIN))
    expect(t.checked(BIW)).toBe(1)

    t.line.failProfileFor.clear()
    await t.tick(new Date(SLOT.getTime() + DAY))
    expect(t.checked(BIW)).toBe(2)
    expect(t.member(BIW).leftAt).not.toBeNull()
    expect(t.leaveCards()).toHaveLength(1)
  })

  it('several 15-minute ticks in one day run the check once', async () => {
    const t = setup()
    for (let i = 0; i < 8; i++) await t.tick(new Date(SLOT.getTime() + i * 15 * MIN))
    expect(t.line.profileCalls).toHaveLength(3)
    await t.tick(new Date(SLOT.getTime() + DAY))
    expect(t.line.profileCalls).toHaveLength(6)
  })

  it('does not run before its Bangkok time', async () => {
    const t = setup()
    t.biwLeaves()
    await t.tick(new Date(SLOT.getTime() - 15 * MIN))
    expect(t.line.profileCalls).toEqual([])
    expect(t.member(BIW).leftAt).toBeNull()
  })

  it('stops at the deadline, and the next tick goes on from where it stopped', async () => {
    const t = setup()
    t.biwLeaves()
    t.line.profileMs = 20_000 // every tick, not only the first
    await t.tick(SLOT)
    // 55 s from the tick's start, 10 s per LINE call. Biw is asked with 15 s left; after the
    // 404 there is no time for the group recheck and the card, so the tick stops before
    // marking him.
    expect(t.line.profileCalls.map((c) => c.lineUserId)).toEqual([OWNER, TON, BIW])
    expect(t.member(BIW).leftAt).toBeNull()
    expect(t.line.pushes).toEqual([])

    await t.tick(new Date(SLOT.getTime() + 15 * MIN))
    expect(t.line.profileCalls.map((c) => c.lineUserId)).toEqual([OWNER, TON, BIW, BIW]) // no restart
    expect(t.member(BIW).leftAt).not.toBeNull()
    expect(t.leaveCards()).toHaveLength(1)
    await t.tick(new Date(SLOT.getTime() + 30 * MIN))
    expect(t.line.profileCalls).toHaveLength(4)
  })

  it('a bot removed during the check marks nobody', async () => {
    const t = setup()
    t.biwLeaves()
    // LINE knows the group at the start, then answers 404 for it: the bot was removed.
    vi.spyOn(t.line, 'getGroupSummary').mockResolvedValueOnce({ groupName: 'ทีมโปสเตอร์' }).mockResolvedValue(null)
    await t.tick(SLOT)
    expect(t.checked(BIW)).toBe(1)
    expect(t.member(BIW).leftAt).toBeNull()
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: BIW })
    expect(t.line.pushes).toEqual([])
  })

  it('a leave whose Task release failed is released by the next run', async () => {
    const t = setup()
    t.biwLeaves()
    t.store.failNext('releaseTasksIfLeft')
    await t.tick(SLOT)
    expect(t.member(BIW).leftAt).not.toBeNull()
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: BIW }) // the write failed
    await t.tick(new Date(SLOT.getTime() + 15 * MIN))
    expect(t.task(t.slides.id)).toMatchObject({ assigneeLineUserId: null, status: 'not_assigned' })
    expect(t.leaveCards()).toHaveLength(1)
  })

  it('a group the tick has no time for is left to the next tick', async () => {
    const t = setup()
    t.line.profileMs = 20_000
    const other = t.store.seedGroup({ lineGroupId: 'Cother', projectId: t.group.projectId })
    t.store.seedMember({ groupId: other.id, lineUserId: 'Ustranger', displayName: 'x' })
    t.line.groupNames.set('Cother', 'อื่น')
    t.line.profiles.set('Cother:Ustranger', 'x')
    await t.tick(SLOT)
    await t.tick(new Date(SLOT.getTime() + 15 * MIN))
    t.line.profileMs = 0
    await t.tick(new Date(SLOT.getTime() + 30 * MIN))
    // Every Member of both groups was asked by the end, and each group finished once.
    for (const u of [OWNER, TON, BIW]) expect(t.checked(u)).toBeGreaterThanOrEqual(1)
    expect(t.checked('Ustranger')).toBe(1)
    const calls = t.line.profileCalls.length
    await t.tick(new Date(SLOT.getTime() + 45 * MIN))
    expect(t.line.profileCalls).toHaveLength(calls)
  })

  it('marks nobody in a group the bot is no longer in', async () => {
    const t = setup()
    t.line.groupNames.clear() // LINE answers 404 for the group itself
    for (const u of [OWNER, TON, BIW]) t.line.profiles.delete(`${LINE_GROUP}:${u}`)
    await t.tick(SLOT)
    expect(t.line.profileCalls).toEqual([])
    expect(t.member(BIW).leftAt).toBeNull()
    expect(t.line.pushes).toEqual([])
  })

  it('checks groups that are not set up too, as the leave webhook handles them', async () => {
    const t = setup()
    const other = t.store.seedGroup({ lineGroupId: 'Cother' })
    t.store.seedMember({ groupId: other.id, lineUserId: 'Ustranger', displayName: 'x' })
    t.line.groupNames.set('Cother', 'อื่น')
    await t.tick(SLOT)
    expect(t.line.profileCalls).toContainEqual({ lineGroupId: 'Cother', lineUserId: 'Ustranger' })
    expect(t.store.tables.group_members.find((m) => m.groupId === other.id)!.leftAt).not.toBeNull()
  })
})
