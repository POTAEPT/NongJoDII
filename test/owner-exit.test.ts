import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishGoogleSignIn } from '@/server/google/callback'
import { DRIVE_CALL_MAX_MS, DRIVE_HARD_STOP_MS } from '@/server/google/drive-folders'
import { startGoogleSignIn } from '@/server/google/start'
import type { LineMessage } from '@/server/line/types'
import {
  OWNER_CLAIM_HOLD_MS, OWNER_EXIT_AFTER_DAYS, OWNER_EXIT_BATCH, OWNER_NEEDED_TEXT, ownerExitJob,
} from '@/server/members/owner-left'
import { confirmOwner } from '@/server/setup/confirm'
import { submitSetup } from '@/server/setup/submit'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_NOW, tickRequest, webhookBody } from './harness'

// #30 part B through the tick seam: pg_cron's POST goes in at a fake time; LINE leave calls,
// the groups' marks, detaches and owner_needed cards come out. A main group (or a group with
// no Project) that has had no confirmed Owner for OWNER_EXIT_AFTER_DAYS is left by the bot
// (botLeaveGroup, #11), which starts the 7-day deletion at once. A Sub group detaches from its
// Project instead and gets a fresh card (decided 2026-11-15). An open claim on the Owner role
// holds either step for at most 24 h after the press (decided 2026-11-15, option A).

const DAY = 86_400_000
const HOUR = 3_600_000
const MIN = 60_000
const at = (ms: number) => new Date(TEST_NOW.getTime() + ms)
const OWNER = 'Uowner1'
const PIM = 'Upim'
const TOKEN: Record<string, string> = { [PIM]: 'idtok-pim' }

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

type H = ReturnType<typeof makeTestDeps>

function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  h.line.idTokens.set(TOKEN[PIM], { lineUserId: PIM, displayName: 'พิม' })

  const leaveAsOwner = async (groupId: string, when: Date) => {
    await h.store.markMemberLeft({ groupId, lineUserId: OWNER, at: when })
    expect((await h.store.markOwnerLeft({ groupId, lineUserId: OWNER, at: when })).updated).toBe(true)
    // The member_left job's owner_needed card (#30 part A). Without it the tick's reconcile
    // (members/owner-needed-reconcile.ts) would open and post one.
    await h.store.openOwnerNeededPrompt({ groupId, subjectLineUserId: OWNER, askedAt: when })
  }

  /** A main group OWNER set up and confirmed (its own Project), PIM a live Member; OWNER
   *  left the group at `ownerLeftAt` (the leave path's writes). */
  const mainOwnerless = async (lineGroupId: string, ownerLeftAt: Date) => {
    const g = h.store.seedGroup({ lineGroupId, nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'เจ้าของ' })
    h.store.seedMember({ groupId: g.id, lineUserId: PIM, displayName: 'พิม' })
    h.line.groupMemberCounts.set(lineGroupId, 2)
    expect((await h.store.confirmGroupOwner(g.id, OWNER, at(-30 * DAY))).outcome).toBe('confirmed')
    await leaveAsOwner(g.id, ownerLeftAt)
    return { groupId: g.id, projectId: h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string }
  }

  /** A Sub group of `projectId`, Owner OWNER confirmed, PIM a live Member, folder ID set;
   *  OWNER left it at `ownerLeftAt`. */
  const subOwnerless = async (projectId: string, lineGroupId: string, ownerLeftAt: Date) => {
    const g = h.store.seedGroup({ lineGroupId, projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: at(-30 * DAY) })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'เจ้าของ' })
    h.store.seedMember({ groupId: g.id, lineUserId: PIM, displayName: 'พิม' })
    h.store.tables.group_setups.push({
      groupId: g.id, isMain: false, featureSaveFiles: true, ownerNominatedByLineUserId: null, ownerNominatedAt: null,
      driveFolderId: 'folder-old',
    })
    h.line.groupMemberCounts.set(lineGroupId, 2)
    await leaveAsOwner(g.id, ownerLeftAt)
    return g.id
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
  const group = (id: string) => h.store.tables.groups.find((r) => r.id === id)!
  return { ...h, mainOwnerless, subOwnerless, tickAt, marks, group }
}

/** Google sign-in from start to callback (account `n`), then the deferred work. */
async function signIn(h: H, who: string, n: number) {
  h.google.exchangeResult = {
    refreshToken: `rt-${n}`, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: `g-sub-${n}`, email: `p${n}@example.com`,
  }
  const res = await startGoogleSignIn(h.deps, { idToken: TOKEN[who] })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  const outcome = await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'code-1', state }), h.defer)
  await h.runDeferred()
  return outcome
}

/** Every text in a Flex tree. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  return [...(o.type === 'text' && typeof o.text === 'string' ? [o.text] : []), ...Object.values(o).flatMap(texts)]
}
const isOwnerCard = (m: LineMessage) => texts(m.type === 'flex' ? m.contents : null).includes(OWNER_NEEDED_TEXT.title)

describe('a main group with no new Owner after 7 days (#30 part B)', () => {
  it('is in the tick', () => {
    expect(TICK_JOBS).toContain(ownerExitJob)
    expect(OWNER_EXIT_AFTER_DAYS).toBe(7)
  })

  it('the bot leaves on the first tick at 7 days, and the 7-day deletion starts at once', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    await t.tickAt(at(7 * DAY - 15 * MIN))
    expect(t.line.leaveCalls).toEqual([])
    const due = at(7 * DAY)
    await t.tickAt(due)
    expect(t.line.leaveCalls).toEqual(['Cg1'])
    expect(t.marks(groupId)).toEqual({ leftAt: due, deleteAfter: new Date(due.getTime() + 7 * DAY) })
    expect(t.line.pushes).toEqual([]) // posts nothing
  })

  it('leaves once: later ticks find the group marked', async () => {
    const t = setup()
    await t.mainOwnerless('Cg1', TEST_NOW)
    await t.tickAt(at(7 * DAY))
    await t.tickAt(at(7 * DAY + 15 * MIN))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
  })

  it('a group whose new Owner confirmed (complete_owner_change) stays', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    expect((await t.store.claimOwnerChange(groupId, PIM, at(DAY))).outcome).toBe('claimed')
    expect(await signIn(t, PIM, 2)).toBe('ok') // the callback runs complete_owner_change
    expect(t.group(groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerLeftAt: null })
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

  it('a re-invite before day 7 restarts the count', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    const rejoin = at(5 * DAY)
    await t.store.markBotJoined({ groupId, at: rejoin })
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toEqual([])
    await t.tickAt(new Date(rejoin.getTime() + 7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
  })

  it('a re-invite after the bot left, inside the delete window, clears the mark and restarts the count', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    await t.tickAt(at(7 * DAY))
    expect(t.marks(groupId).leftAt).toEqual(at(7 * DAY))
    const rejoin = at(8 * DAY)
    const res = await handleWebhookRequest(signedRequest(webhookBody(ev.join({ groupId: 'Cg1', timestamp: rejoin.getTime() }))), t.deps, t.defer)
    expect(res.status).toBe(200)
    await t.runDeferred()
    expect(t.marks(groupId)).toEqual({ leftAt: null, deleteAfter: null })
    expect(t.group(groupId).ownerLeftAt).toEqual(rejoin)
    await t.tickAt(at(8 * DAY + 15 * MIN))
    await t.tickAt(at(14 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
    await t.tickAt(new Date(rejoin.getTime() + 7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cg1', 'Cg1'])
  })

  it('a new Owner confirmed between the list and the leave keeps the bot in the group', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    expect((await t.store.claimOwnerChange(groupId, PIM, at(DAY))).outcome).toBe('claimed')
    await t.store.upsertGoogleAccount({
      lineUserId: PIM, googleSubject: 'g-sub-2', email: null, grantedScopes: [], refreshTokenCiphertext: 'x', signedInAt: at(DAY),
    })
    const list = t.store.listOwnerlessGroups.bind(t.store)
    t.store.listOwnerlessGroups = async (before, limit) => {
      const listed = await list(before, limit)
      // The new Owner's Drive sign-in lands while the tick works through earlier groups.
      expect((await t.store.completeOwnerChange(groupId, PIM, t.deps.now())).outcome).toBe('changed')
      return listed
    }
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toEqual([])
    expect(t.marks(groupId).leftAt).toBeNull()
  })

  it('uses the time of the leave itself, not the tick start', async () => {
    const t = setup()
    const a = await t.mainOwnerless('Cg1', at(-1))
    const b = await t.mainOwnerless('Cg2', TEST_NOW)
    t.line.leaveMs = 20_000
    const tick = at(7 * DAY)
    await t.tickAt(tick)
    const first = t.line.leaveCalls[0] === 'Cg1' ? a : b
    const second = first === a ? b : a
    expect(t.marks(first.groupId).leftAt).toEqual(tick)
    expect(t.marks(second.groupId).leftAt).toEqual(new Date(tick.getTime() + 20_000))
  })

  it('a LINE 5xx leaves the group unmarked, the others go on, and the next tick tries again', async () => {
    const t = setup()
    const g1 = await t.mainOwnerless('Cg1', TEST_NOW)
    const g2 = await t.mainOwnerless('Cg2', at(-1000))
    t.line.failLeave = true
    await t.tickAt(at(7 * DAY))
    expect(new Set(t.line.leaveCalls)).toEqual(new Set(['Cg1', 'Cg2']))
    expect(t.marks(g1.groupId).leftAt).toBeNull()
    t.line.failLeave = false
    const retry = at(7 * DAY + 15 * MIN)
    await t.tickAt(retry)
    expect(t.marks(g1.groupId).leftAt).toEqual(retry)
    expect(t.marks(g2.groupId).leftAt).toEqual(retry)
  })

  it('the bot already out of the group (LINE 404) is marked all the same', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    t.line.leaveNotInGroup = true
    await t.tickAt(at(7 * DAY))
    expect(t.marks(groupId).leftAt).toEqual(at(7 * DAY))
  })

  it('a store failure after LINE accepted the leave: the next tick gets a 404 and marks the group', async () => {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    t.store.failNext('markBotLeft')
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cg1'])
    expect(t.marks(groupId).leftAt).toBeNull()
    t.line.leaveNotInGroup = true // the bot is already out
    const retry = at(7 * DAY + 15 * MIN)
    await t.tickAt(retry)
    expect(t.line.leaveCalls).toEqual(['Cg1', 'Cg1'])
    expect(t.marks(groupId)).toEqual({ leftAt: retry, deleteAfter: new Date(retry.getTime() + 7 * DAY) })
  })

  it('stops before a LINE call that could not end inside the tick, and the next tick goes on', async () => {
    const t = setup()
    for (let i = 0; i < 3; i++) await t.mainOwnerless(`Cg${i}`, at(-i))
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

  it(`works through at most ${OWNER_EXIT_BATCH} groups per tick`, async () => {
    const t = setup()
    for (let i = 0; i < OWNER_EXIT_BATCH + 10; i++) await t.mainOwnerless(`Cg${i}`, at(-i))
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toHaveLength(OWNER_EXIT_BATCH)
    await t.tickAt(at(7 * DAY + 15 * MIN))
    expect(new Set(t.line.leaveCalls).size).toBe(OWNER_EXIT_BATCH + 10)
  })

  it('groups that keep failing at the head of the list do not starve the others', async () => {
    const t = setup()
    // Ten groups that always fail, oldest first, then one that would leave fine.
    for (let i = 0; i < 10; i++) {
      await t.mainOwnerless(`Cbad${i}`, at(-DAY - i))
      t.line.failLeaveFor.add(`Cbad${i}`)
    }
    const good = await t.mainOwnerless('Cgood', TEST_NOW)
    t.line.leaveMs = DRIVE_CALL_MAX_MS // every call runs to its timeout: 5 fit in a tick
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toHaveLength(5)
    for (let k = 1; k < 3; k++) await t.tickAt(at(7 * DAY + k * 15 * MIN))
    expect(t.marks(good.groupId).leftAt).not.toBeNull()
  })
})

describe('an open claim on the Owner role holds the exit for at most 24 h (#30 part B, option A)', () => {
  async function claimedAt(press: Date) {
    const t = setup()
    const { groupId } = await t.mainOwnerless('Cg1', TEST_NOW)
    t.setNow(press)
    expect((await confirmOwner(t.deps, { idToken: TOKEN[PIM], groupId }, t.defer)).body).toEqual({ state: 'needs_drive' })
    await t.runDeferred()
    return { ...t, groupId }
  }

  it('a claim made at day 6 + 23 h is held at day 7', async () => {
    const t = await claimedAt(at(6 * DAY + 23 * HOUR))
    await t.tickAt(at(7 * DAY))
    await t.tickAt(at(7 * DAY + 10 * HOUR))
    expect(t.line.leaveCalls).toEqual([])
    expect(t.marks(t.groupId).leftAt).toBeNull()
  })

  it('the nominee who confirms at day 7 + 10 h keeps the bot in the group', async () => {
    const t = await claimedAt(at(6 * DAY + 23 * HOUR))
    await t.tickAt(at(7 * DAY))
    t.setNow(at(7 * DAY + 10 * HOUR))
    expect(await signIn(t, PIM, 2)).toBe('ok')
    expect(t.group(t.groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerLeftAt: null })
    await t.tickAt(at(9 * DAY))
    expect(t.line.leaveCalls).toEqual([])
  })

  it('a nominee who never connects Drive: the bot leaves at the first tick 24 h after the press', async () => {
    const press = at(6 * DAY + 23 * HOUR)
    const t = await claimedAt(press)
    expect(OWNER_CLAIM_HOLD_MS).toBe(24 * HOUR)
    await t.tickAt(new Date(press.getTime() + 24 * HOUR - 15 * MIN))
    expect(t.line.leaveCalls).toEqual([])
    const end = new Date(press.getTime() + 24 * HOUR)
    await t.tickAt(end)
    expect(t.line.leaveCalls).toEqual(['Cg1'])
    expect(t.marks(t.groupId).leftAt).toEqual(end)
  })
})

describe('a Sub group with no new Owner after 7 days (#30 part B, decided 2026-11-15)', () => {
  async function subSetup() {
    const t = setup()
    // The main group keeps its Owner; only the Sub group's Owner left.
    const main = seedOwnedGroup(t.store, { lineGroupId: 'Cmain' })
    t.store.tables.group_setups.push({ groupId: main.id, isMain: true, featureSaveFiles: true, ownerNominatedByLineUserId: null, ownerNominatedAt: null })
    const projectId = main.projectId as string
    t.store.tables.projects.push({ id: projectId, ownerLineUserId: OWNER })
    const subId = await t.subOwnerless(projectId, 'Csub', TEST_NOW)
    return { ...t, subId, projectId }
  }

  it('detaches at day 7 (no Project, no folder ID, a fresh count) and the bot stays', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY - 15 * MIN))
    expect(t.group(t.subId).projectId).toBe(t.projectId)
    const due = at(7 * DAY)
    await t.tickAt(due)
    expect(t.line.leaveCalls).toEqual([])
    expect(t.group(t.subId)).toMatchObject({ projectId: null, ownerConfirmedAt: null, ownerLeftAt: due })
    expect(t.store.tables.group_setups.find((r) => r.groupId === t.subId)?.driveFolderId).toBeNull()
    expect(t.marks(t.subId).leftAt).toBeNull()
  })

  it('posts a fresh owner_needed card once, through the push budget', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY))
    await t.tickAt(at(7 * DAY + 15 * MIN))
    await t.tickAt(at(8 * DAY))
    expect(t.line.pushes).toHaveLength(1)
    expect(t.line.pushes[0].to).toBe('Csub')
    expect(isOwnerCard(t.line.pushes[0].messages[0])).toBe(true)
    expect(t.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'owner_needed', lineTargetId: 'Csub' })])
  })

  it('a Member can then take the Owner role: LINE login, then Drive, and the group gets its own Project', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY))
    t.setNow(at(8 * DAY))
    const pressed = await confirmOwner(t.deps, { idToken: TOKEN[PIM], groupId: t.subId }, t.defer)
    expect(pressed).toEqual({ status: 200, body: { state: 'needs_drive' } })
    expect(t.group(t.subId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerConfirmedAt: null })
    expect(await signIn(t, PIM, 2)).toBe('ok')
    const g = t.group(t.subId)
    expect(g).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerLeftAt: null })
    expect(g.ownerConfirmedAt).not.toBeNull()
    expect(g.projectId).not.toBeNull()
    expect(g.projectId).not.toBe(t.projectId)
    expect(t.store.tables.projects.find((p) => p.id === g.projectId)!.ownerLineUserId).toBe(PIM)
    expect(t.store.tables.owner_prompts.filter((p) => p.groupId === t.subId && p.answer === null)).toEqual([])
    // The bot stays after another 7 days.
    await t.tickAt(at(15 * DAY))
    expect(t.line.leaveCalls).toEqual([])
  })

  it('with no new Owner by day 14 the bot leaves', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY))
    await t.tickAt(at(14 * DAY - 15 * MIN))
    expect(t.line.leaveCalls).toEqual([])
    await t.tickAt(at(14 * DAY))
    expect(t.line.leaveCalls).toEqual(['Csub'])
    expect(t.marks(t.subId).leftAt).toEqual(at(14 * DAY))
  })

  it('a main group of the same tick still makes the bot leave at day 7', async () => {
    const t = await subSetup()
    await t.mainOwnerless('Cother', TEST_NOW)
    await t.tickAt(at(7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Cother'])
  })

  it('a re-run after a failure does not detach twice or post twice', async () => {
    const t = await subSetup()
    t.store.failNext('detachOwnerlessSubGroup')
    await t.tickAt(at(7 * DAY))
    expect(t.group(t.subId).projectId).toBe(t.projectId) // nothing written
    expect(t.line.pushes).toEqual([])
    const retry = at(7 * DAY + 15 * MIN)
    await t.tickAt(retry)
    expect(t.group(t.subId)).toMatchObject({ projectId: null, ownerLeftAt: retry })
    expect(t.line.pushes).toHaveLength(1)
    // The detached group is no longer a Sub group: the store refuses a second detach.
    expect((await t.store.detachOwnerlessSubGroup(t.subId, at(30 * DAY), at(30 * DAY))).detached).toBe(false)
    await t.tickAt(at(7 * DAY + 30 * MIN))
    expect(t.line.pushes).toHaveLength(1)
    expect(t.group(t.subId).ownerLeftAt).toEqual(retry)
  })

  const form = (groupId: string, ownerLineUserId: string) => ({
    idToken: TOKEN[PIM], groupId, workDescription: 'งานใหม่',
    features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
    members: [{ lineUserId: PIM, nicknames: [], role: '' }], ownerLineUserId,
  })

  it('the setup form on a detached group does not confirm without Drive; the Google callback then does', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY))
    t.setNow(at(8 * DAY))
    // Naming yourself is the claim, held until Drive is connected.
    const res = await submitSetup(t.deps, form(t.subId, PIM), t.defer)
    await t.runDeferred()
    expect(res).toEqual({ status: 200, body: { state: 'needs_drive' } })
    expect(t.group(t.subId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerConfirmedAt: null, projectId: null })
    expect(t.store.tables.projects).toHaveLength(1) // no new Project yet
    // Naming someone else is refused: that person takes the card themselves.
    expect(await submitSetup(t.deps, form(t.subId, OWNER), t.defer)).toEqual({ status: 409, body: { error: 'owner_needed' } })

    expect(await signIn(t, PIM, 2)).toBe('ok')
    const g = t.group(t.subId)
    expect(g).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerLeftAt: null })
    expect(g.ownerConfirmedAt).not.toBeNull()
    expect(g.projectId).not.toBeNull()
  })

  it('a brand-new group\'s setup is unchanged: naming yourself confirms at once', async () => {
    const t = setup()
    const g = t.store.seedGroup({ lineGroupId: 'Cfresh' })
    t.store.seedMember({ groupId: g.id, lineUserId: PIM, displayName: 'พิม' })
    t.line.groupMemberCounts.set('Cfresh', 1)
    const res = await submitSetup(t.deps, form(g.id, PIM), t.defer)
    await t.runDeferred()
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'confirmed' })
    expect(t.group(g.id).ownerConfirmedAt).not.toBeNull()
    expect(t.group(g.id).projectId).not.toBeNull()
  })

  it('an open claim holds the detach for at most 24 h after the press', async () => {
    const t = await subSetup()
    const press = at(6 * DAY + 23 * HOUR)
    Object.assign(t.store.tables.group_setups.find((r) => r.groupId === t.subId)!, { ownerNominatedAt: press })
    await t.tickAt(at(7 * DAY))
    expect(t.group(t.subId).projectId).toBe(t.projectId)
    await t.tickAt(new Date(press.getTime() + 24 * HOUR))
    expect(t.group(t.subId).projectId).toBeNull()
  })

  it('a Sub group that changed between the list and the detach (a re-invite) is not detached', async () => {
    const t = await subSetup()
    const list = t.store.listOwnerlessGroups.bind(t.store)
    t.store.listOwnerlessGroups = async (before, limit) => {
      const listed = await list(before, limit)
      await t.store.markBotJoined({ groupId: t.subId, at: t.deps.now() })
      return listed
    }
    await t.tickAt(at(7 * DAY))
    expect(t.group(t.subId)).toMatchObject({ projectId: t.projectId, ownerLeftAt: at(7 * DAY) })
    expect(t.line.pushes).toEqual([])
  })

  it('#31 take-over expiry first: a backlog Sub group gets a fresh 7 days, one card, and the bot leaves only at day 14', async () => {
    const t = await subSetup()
    // Its Owner left long ago, and the Project's Owner changed at TEST_NOW: it waits on the
    // take-over question, which expires at day 7 in the same tick as the owner exit.
    t.store.seedSchedule(t.subId, { ownerLeftAt: at(-10 * DAY) })
    t.store.tables.group_setups.find((r) => r.groupId === t.subId)!.takeoverAskedAt = TEST_NOW
    const due = at(7 * DAY + 15 * MIN)
    await t.tickAt(due)
    expect(t.line.leaveCalls).toEqual([])
    expect(t.group(t.subId)).toMatchObject({ projectId: null, ownerLeftAt: due })
    expect(t.line.pushes).toHaveLength(1)
    expect(isOwnerCard(t.line.pushes[0].messages[0])).toBe(true)
    await t.tickAt(new Date(due.getTime() + 7 * DAY - 15 * MIN))
    expect(t.line.leaveCalls).toEqual([])
    await t.tickAt(new Date(due.getTime() + 7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Csub'])
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a re-invite to a detached group resets owner_left_at and restarts the count', async () => {
    const t = await subSetup()
    await t.tickAt(at(7 * DAY))
    const rejoin = at(10 * DAY)
    await t.store.markBotJoined({ groupId: t.subId, at: rejoin })
    expect(t.group(t.subId).ownerLeftAt).toEqual(rejoin)
    await t.tickAt(at(14 * DAY))
    expect(t.line.leaveCalls).toEqual([])
    await t.tickAt(new Date(rejoin.getTime() + 7 * DAY))
    expect(t.line.leaveCalls).toEqual(['Csub'])
  })
})
