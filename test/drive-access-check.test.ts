import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { seal } from '@/server/crypto/secretbox'
import { ACCESS_CHECK_STEP, ACCESS_CHECK_TIME, driveAccessCheckJob, isAccessCheckSlot, rotateForDay } from '@/server/google/access-check'
import { DRIVE_CALL_MAX_MS, driveDeadline, ensureDriveFolders } from '@/server/google/drive-folders'
import { liffUrl } from '@/server/liff-links'
import { AdapterError } from '@/server/log'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { makeTestDeps, TEST_KEY, TEST_LIFF_ID, TEST_NOW, tickRequest } from './harness'

// #14: the daily access check. Without it a revocation shows only when a Drive run happens,
// which is rare once the folders exist. Once a day, on one fixed 15-minute tick, the job
// refreshes the token of each Google account that holds a Project's active Drive
// connection; an account Google refuses is marked and its main group gets the card, once.

const MIN = 60_000
/** The Bangkok day of TEST_NOW (10:00) at `hhmm` Bangkok time. */
const bkk = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00+07:00`)
const SLOT = bkk(ACCESS_CHECK_TIME)

let infos: MockInstance<typeof console.info>
let errors: MockInstance<typeof console.error>
beforeEach(() => {
  infos = vi.spyOn(console, 'info').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})
const infoEvents = () => infos.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
const logged = () => [...infos.mock.calls, ...errors.mock.calls].map((c) => String(c[0])).join('\n')

type H = ReturnType<typeof makeTestDeps>

/** Owner number `n` with a confirmed Project (main group Cmain<n>), a Google account
 *  (refresh token rt-<n>) and the Drive folders laid out: an active connection. */
async function seedConnectedOwner(h: H, n: number) {
  const owner = `Uowner${n}`
  const lineGroupId = `Cmain${n}`
  const g = h.store.seedGroup({ lineGroupId, name: `ทีม ${n}`, nominatedOwnerLineUserId: owner })
  h.store.seedMember({ groupId: g.id, lineUserId: owner, displayName: `Owner ${n}` })
  h.line.groupMemberCounts.set(lineGroupId, 2)
  expect((await h.store.confirmGroupOwner(g.id, owner, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
  const { id: accountId } = await h.store.upsertGoogleAccount({
    lineUserId: owner, googleSubject: `g-sub-${n}`, email: `owner${n}@example.com`, grantedScopes: [],
    refreshTokenCiphertext: seal(`rt-${n}`, TEST_KEY), signedInAt: h.deps.now(),
  })
  await ensureDriveFolders(h.deps, projectId, driveDeadline(h.deps.now()))
  return { owner, groupId: g.id, lineGroupId, projectId, accountId }
}

/** The sign-in cards pushed so far (the full tick also posts reminders). */
const cards = (h: H) => h.line.pushes.filter((p) => p.messages[0].type === 'template')

const accountRow = (h: H, id: string) => h.store.tables.google_accounts.find((a) => a.id === id)!

/** One tick at `at` with only the access check, or with `jobs`. */
async function tick(h: H, at: Date, jobs = [driveAccessCheckJob]) {
  h.setNow(at)
  h.google.refreshCalls = []
  expect((await handleTickRequest(tickRequest(), h.deps, h.defer, jobs)).status).toBe(200)
  await h.runDeferred()
}

describe('isAccessCheckSlot', () => {
  it('is true for the one 15-minute tick that starts at the chosen Bangkok time', () => {
    expect(isAccessCheckSlot(SLOT)).toBe(true)
    expect(isAccessCheckSlot(new Date(SLOT.getTime() + 14 * MIN + 59_000))).toBe(true)
    expect(isAccessCheckSlot(new Date(SLOT.getTime() + 15 * MIN))).toBe(false)
    expect(isAccessCheckSlot(new Date(SLOT.getTime() - 1000))).toBe(false)
    expect(isAccessCheckSlot(new Date(SLOT.getTime() + 24 * 60 * MIN))).toBe(true) // the next day
  })
  it('is a daytime slot on the quarter hour', () => {
    expect(ACCESS_CHECK_TIME).toMatch(/^(0[8-9]|1[0-9]):(00|15|30|45)$/)
  })
})

describe('rotateForDay', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const day = (n: number) => new Date(SLOT.getTime() + n * 24 * 60 * MIN)
  it('keeps every item, and moves the start by ACCESS_CHECK_STEP each Bangkok day', () => {
    const first = rotateForDay(ids, day(0))
    const next = rotateForDay(ids, day(1))
    expect([...first].sort()).toEqual(ids)
    expect(next[0]).toBe(first[ACCESS_CHECK_STEP % ids.length])
    expect(rotateForDay(ids, new Date(day(0).getTime() + 5 * MIN))).toEqual(first) // same day, same order
  })
  it('handles an empty list', () => expect(rotateForDay([], day(0))).toEqual([]))
})

describe('daily Drive access check', () => {
  it('runs with every tick, before the Drive setup finisher', () => {
    const names = TICK_JOBS.map((j) => j.name)
    expect(names).toContain('drive_access_check')
    expect(names.indexOf('drive_access_check')).toBeLessThan(names.indexOf('drive_setup'))
  })

  it('an Owner who revoked access long after setup is marked and the main group gets one card', async () => {
    const h = makeTestDeps()
    const a = await seedConnectedOwner(h, 1)
    const task = h.store.seedTask({ groupId: a.groupId, title: 'ส่งรายงาน', createdByLineUserId: a.owner })
    const tasksBefore = structuredClone(h.store.tables.tasks)
    const connections = structuredClone(h.store.tables.drive_connections)
    h.google.revokedRefreshTokens.add('rt-1')

    // A week later, well outside the 2-hour window of the setup finisher.
    await tick(h, new Date(SLOT.getTime() + 7 * 24 * 60 * MIN), TICK_JOBS)

    expect(accountRow(h, a.accountId)).toMatchObject({ tokenStatus: 'revoked', refreshTokenCiphertext: null })
    expect(cards(h)).toHaveLength(1)
    expect(cards(h)[0].to).toBe(a.lineGroupId)
    const m = cards(h)[0].messages[0]
    expect(m.type === 'template' && m.template.actions).toEqual([
      { type: 'uri', label: 'เข้าสู่ระบบ Google', uri: liffUrl(TEST_LIFF_ID, 'google') },
    ])
    expect(h.store.tables.push_log.filter((p) => p.purpose === 'drive_revoked')).toEqual([
      expect.objectContaining({ lineTargetId: a.lineGroupId }),
    ])
    // Tasks, the connection and the folder IDs stay.
    expect(h.store.tables.tasks).toEqual(tasksBefore)
    expect(task.id).toBe(h.store.tables.tasks[0].id)
    expect(h.store.tables.drive_connections).toEqual(connections)
    expect(h.store.tables.projects.find((p) => p.id === a.projectId)?.driveProjectFolderId).toBeTruthy()

    // The next days: the account is revoked, so it is not tried and nothing is sent again.
    await tick(h, new Date(SLOT.getTime() + 8 * 24 * 60 * MIN), TICK_JOBS)
    expect(h.google.refreshCalls).toEqual([])
    expect(cards(h)).toHaveLength(1)
  })

  it('leaves a valid account untouched: one refresh, no write, no push', async () => {
    const h = makeTestDeps()
    const a = await seedConnectedOwner(h, 1)
    const before = structuredClone(accountRow(h, a.accountId))
    await tick(h, SLOT)
    expect(h.google.refreshCalls).toEqual(['rt-1'])
    expect(accountRow(h, a.accountId)).toEqual(before)
    expect(h.line.pushes).toEqual([])
    expect(infoEvents()).toContainEqual({ event: 'drive_access_check', accounts: 1, revoked: 0, skipped: 0, complete: true })
  })

  it('does nothing outside its slot', async () => {
    const h = makeTestDeps()
    await seedConnectedOwner(h, 1)
    h.google.revokedRefreshTokens.add('rt-1')
    for (const at of [new Date(SLOT.getTime() - 15 * MIN), new Date(SLOT.getTime() + 15 * MIN), bkk('03:00'), bkk('22:45')]) {
      await tick(h, at)
      expect(h.google.refreshCalls).toEqual([])
    }
    expect(h.store.tables.google_accounts[0].tokenStatus).toBe('valid')
    expect(h.line.pushes).toEqual([])
    expect(infoEvents().map((e) => e.event)).not.toContain('drive_access_check')
  })

  it('a timeout or a Google 5xx marks nothing: the account is tried again the next day', async () => {
    const h = makeTestDeps()
    const a = await seedConnectedOwner(h, 1)
    for (const err of [new AdapterError('google timeout'), new AdapterError('google refresh 503')]) {
      h.google.refreshError = err
      await tick(h, SLOT)
      expect(accountRow(h, a.accountId).tokenStatus).toBe('valid')
      expect(h.line.pushes).toEqual([])
    }
    expect(infoEvents()).toContainEqual({ event: 'drive_access_check', accounts: 1, revoked: 0, skipped: 1, complete: true })
    h.google.refreshError = null
    h.google.revokedRefreshTokens.add('rt-1')
    await tick(h, new Date(SLOT.getTime() + 24 * 60 * MIN))
    expect(accountRow(h, a.accountId).tokenStatus).toBe('revoked')
    expect(h.line.pushes).toHaveLength(1)
  })

  it('tries each account once, however many Projects it holds, and one failure does not stop the others', async () => {
    const h = makeTestDeps()
    const a = await seedConnectedOwner(h, 1)
    // A second Project of the same Owner, on the same Google account.
    const g = h.store.seedGroup({ lineGroupId: 'Csecond', name: 'ทีมสอง', nominatedOwnerLineUserId: a.owner })
    h.store.seedMember({ groupId: g.id, lineUserId: a.owner, displayName: 'Owner 1' })
    expect((await h.store.confirmGroupOwner(g.id, a.owner, TEST_NOW)).outcome).toBe('confirmed')
    await ensureDriveFolders(h.deps, h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string, driveDeadline(h.deps.now()))
    const b = await seedConnectedOwner(h, 2)
    const c = await seedConnectedOwner(h, 3)
    h.google.revokedRefreshTokens.add('rt-1')
    h.google.revokedRefreshTokens.add('rt-3')
    h.store.failNext('markGoogleAccountRevoked') // the first revoked account's write fails

    await tick(h, SLOT)

    expect([...h.google.refreshCalls].sort()).toEqual(['rt-1', 'rt-2', 'rt-3'])
    // Whichever revoked account came first stays valid (tomorrow's check meets it again);
    // the other one is marked and its group gets the card.
    expect(accountRow(h, b.accountId).tokenStatus).toBe('valid')
    const marked = [a, c].filter((x) => accountRow(h, x.accountId).tokenStatus === 'revoked')
    expect(marked).toHaveLength(1)
    expect(h.line.pushes).toHaveLength(1)
    expect([a.lineGroupId, 'Csecond', c.lineGroupId]).toContain(h.line.pushes[0].to)
    expect(h.line.pushes[0].to === c.lineGroupId).toBe(marked[0] === c)
    expect(infoEvents()).toContainEqual({ event: 'drive_access_check', accounts: 3, revoked: 1, skipped: 1, complete: true })
  })

  it('skips a Project whose active connection is not its Owner\'s latest account, and an account already revoked', async () => {
    const h = makeTestDeps()
    const a = await seedConnectedOwner(h, 1)
    // The Owner signed in with another account without changing: the holder is not the latest.
    await h.store.upsertGoogleAccount({
      lineUserId: a.owner, googleSubject: 'g-sub-other', email: null, grantedScopes: [],
      refreshTokenCiphertext: seal('rt-other', TEST_KEY), signedInAt: h.deps.now(),
    })
    const b = await seedConnectedOwner(h, 2)
    accountRow(h, b.accountId).tokenStatus = 'revoked'
    await tick(h, SLOT)
    expect(h.google.refreshCalls).toEqual([])
    expect(h.line.pushes).toEqual([])
  })

  it('stops cleanly when the tick runs out of time, with a count in the log', async () => {
    const h = makeTestDeps()
    for (let n = 1; n <= 7; n++) await seedConnectedOwner(h, n)
    h.google.callMs = DRIVE_CALL_MAX_MS
    await tick(h, SLOT)

    // 55 s from the tick's start, 10 s per refresh, and no call is started that could end late.
    expect(h.google.refreshCalls).toHaveLength(5)
    expect(h.deps.now().getTime() - SLOT.getTime()).toBeLessThanOrEqual(55_000)
    expect(h.store.tables.google_accounts.every((x) => x.tokenStatus === 'valid')).toBe(true)
    expect(infoEvents()).toContainEqual({ event: 'drive_access_check', accounts: 5, revoked: 0, skipped: 0, complete: false })
    expect(errors.mock.calls).toEqual([]) // not a failed job
  })

  it('starts further down the list each day, so accounts a slow day did not reach are reached on the next days', async () => {
    const h = makeTestDeps()
    for (let n = 1; n <= 12; n++) await seedConnectedOwner(h, n)
    h.google.callMs = DRIVE_CALL_MAX_MS // every day is slow: 5 accounts fit
    const tried = new Set<string>()
    for (let day = 0; day < 3; day++) {
      await tick(h, new Date(SLOT.getTime() + day * 24 * 60 * MIN))
      expect(h.google.refreshCalls).toHaveLength(5)
      for (const t of h.google.refreshCalls) tried.add(t)
    }
    expect(tried.size).toBe(12) // ceil(12 / 5) = 3 days reach every account
  })

  it('logs counts and IDs only', async () => {
    const h = makeTestDeps()
    await seedConnectedOwner(h, 1)
    h.google.revokedRefreshTokens.add('rt-1')
    await tick(h, SLOT)
    for (const secret of ['rt-1', 'owner1@example.com', 'Owner 1', 'ทีม 1']) expect(logged()).not.toContain(secret)
  })
})
