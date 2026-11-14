import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { open, seal } from '@/server/crypto/secretbox'
import { finishGoogleSignIn } from '@/server/google/callback'
import {
  DRIVE_CALL_MAX_MS, DRIVE_HARD_STOP_MS, driveDeadline, driveSetupJob, ensureDriveFolders, ensureGroupFolder,
} from '@/server/google/drive-folders'
import { startGoogleSignIn } from '@/server/google/start'
import { liffUrl } from '@/server/liff-links'
import type { LineMessage } from '@/server/line/types'
import { handleTickRequest } from '@/server/tick/handle-request'
import { makeTestDeps, TEST_KEY, TEST_LIFF_ID, TEST_NOW, tickRequest } from './harness'

// #14 acceptance: a revoked or expired Google grant keeps the Tasks and asks the Owner to
// sign in again, once, in the Project's main group; and the Owner can change the connected
// Google account, which retires the old Drive connection (kept as history) and clears the
// folder IDs.

const OWNER = 'Uowner1'
const OWNER_TOKEN = 'idtok-owner'
const MAIN_LINE_GROUP = 'Cmain'
const MIN = 60_000

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
const fullTime = (h: H) => driveDeadline(h.deps.now())

function setup() {
  const h = makeTestDeps()
  h.line.idTokens.set(OWNER_TOKEN, { lineUserId: OWNER, displayName: 'Owner Name' })
  return h
}

/** A main group whose nominee OWNER confirms: this creates the Project. */
async function seedProject(h: H, lineGroupId = MAIN_LINE_GROUP) {
  const g = h.store.seedGroup({ lineGroupId, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
  h.line.groupMemberCounts.set(lineGroupId, 3)
  expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
  return { groupId: g.id, projectId }
}

/** Google sign-in from start to callback with Google account `n` (subject g-sub-n, refresh
 *  token rt-n, or `refreshToken`), then the deferred Drive work. */
async function signIn(h: H, n: 1 | 2 = 1, refreshToken = `rt-${n}`) {
  h.google.exchangeResult = {
    refreshToken, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: `g-sub-${n}`, email: `owner${n}@example.com`,
  }
  const res = await startGoogleSignIn(h.deps, { idToken: OWNER_TOKEN })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  const outcome = await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'code-1', state }), h.defer)
  await h.runDeferred()
  return outcome
}

const accountOf = (h: H, n: 1 | 2) => h.store.tables.google_accounts.find((a) => a.googleSubject === `g-sub-${n}`)!
const projectRow = (h: H, id: string) => h.store.tables.projects.find((p) => p.id === id)!
const groupFolderId = (h: H, groupId: string) => h.store.tables.group_setups.find((r) => r.groupId === groupId)?.driveFolderId ?? null

function buttons(m: LineMessage) {
  if (m.type !== 'template') throw new Error('not a template')
  return m.template
}

describe('revoked or expired Google access', () => {
  /** A connected Project with two Tasks, then Google revokes the grant. */
  async function connectedThenRevoked(h: H) {
    const p = await seedProject(h)
    expect(await signIn(h)).toBe('ok')
    h.store.seedTask({ groupId: p.groupId, title: 'ส่งรายงาน', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: OWNER })
    h.store.seedTask({ groupId: p.groupId, title: 'นัดประชุม', createdByLineUserId: OWNER })
    h.google.revokedRefreshTokens.add('rt-1')
    h.google.driveCalls = []
    return p
  }

  it('keeps the Tasks, marks the account revoked and posts one sign-in card in the main group', async () => {
    const h = setup()
    const { groupId, projectId } = await connectedThenRevoked(h)
    const tasksBefore = structuredClone(h.store.tables.tasks)
    const projectFolder = projectRow(h, projectId).driveProjectFolderId
    const groupFolder = groupFolderId(h, groupId)
    const connectionsBefore = structuredClone(h.store.tables.drive_connections)

    await ensureDriveFolders(h.deps, projectId, fullTime(h)) // any Drive run meets the revoked grant

    // Tasks are untouched.
    expect(h.store.tables.tasks).toEqual(tasksBefore)
    // The account: revoked, and the dead refresh token is gone.
    expect(accountOf(h, 1)).toMatchObject({ tokenStatus: 'revoked', refreshTokenCiphertext: null })
    // One push, to the main group (never a 1:1 chat), through the push budget.
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(MAIN_LINE_GROUP)
    expect(h.line.replies).toEqual([])
    expect(h.store.tables.push_log).toEqual([
      expect.objectContaining({ purpose: 'drive_revoked', lineTargetId: MAIN_LINE_GROUP, messageCount: 3 }),
    ])
    const card = buttons(h.line.pushes[0].messages[0])
    expect(card.actions).toEqual([{ type: 'uri', label: 'เข้าสู่ระบบ Google', uri: liffUrl(TEST_LIFF_ID, 'google') }])
    expect(card.text).toContain('เข้าสู่ระบบ Google อีกครั้ง')
    expect(card.text).toContain('งาน') // says the Tasks are safe
    expect(card.text.length).toBeLessThanOrEqual(160)
    expect(card.actions[0].label.length).toBeLessThanOrEqual(20)
    // No Drive call, and the connection and folder IDs stay for the same account's return.
    expect(h.google.driveCalls).toEqual([])
    expect(h.store.tables.drive_connections).toEqual(connectionsBefore)
    expect(projectRow(h, projectId).driveProjectFolderId).toBe(projectFolder)
    expect(groupFolderId(h, groupId)).toBe(groupFolder)
  })

  it('posts once per revocation: later runs find the account revoked and send nothing', async () => {
    const h = setup()
    const { groupId, projectId } = await connectedThenRevoked(h)
    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    h.google.refreshCalls = []

    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    expect(await ensureGroupFolder(h.deps, groupId, fullTime(h))).toBeNull()
    h.setNow(new Date(TEST_NOW.getTime() + 15 * MIN))
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [driveSetupJob])).status).toBe(200)
    await h.runDeferred()

    expect(h.line.pushes).toHaveLength(1)
    expect(h.google.refreshCalls).toEqual([]) // a revoked account is not even tried
  })

  it('an Owner with two Projects gets one card, in the main group of the Project whose run met the revocation', async () => {
    const h = setup()
    const first = await seedProject(h)
    const second = await seedProject(h, 'Cmain2')
    expect(await signIn(h)).toBe('ok')
    h.google.revokedRefreshTokens.add('rt-1')

    await ensureDriveFolders(h.deps, second.projectId, fullTime(h))
    await ensureDriveFolders(h.deps, first.projectId, fullTime(h))

    expect(h.line.pushes.map((p) => p.to)).toEqual(['Cmain2'])
  })

  it('two runs that meet the same revocation at once post one card', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    const parked = h.google.hold('refresh:rt-1')
    const runA = ensureDriveFolders(h.deps, projectId, fullTime(h))
    await parked.reached
    const runB = ensureDriveFolders(h.deps, projectId, fullTime(h))
    parked.release()
    await Promise.all([runA, runB])

    expect(h.line.pushes).toHaveLength(1)
    expect(accountOf(h, 1).tokenStatus).toBe('revoked')
  })

  it('a run that used the old token does not revoke a sign-in that finished meanwhile', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    const parked = h.google.hold('refresh:rt-1')
    const run = ensureDriveFolders(h.deps, projectId, fullTime(h))
    await parked.reached // the run holds the old refresh token
    expect(await signIn(h, 1, 'rt-1b')).toBe('ok') // the Owner signs in again: a new grant
    parked.release()
    await run

    expect(accountOf(h, 1).tokenStatus).toBe('valid')
    expect(open(accountOf(h, 1).refreshTokenCiphertext as string, TEST_KEY)).toBe('rt-1b')
    expect(h.line.pushes).toEqual([])
  })

  it('signing in again with the same account restores access and changes nothing else', async () => {
    const h = setup()
    const { groupId, projectId } = await connectedThenRevoked(h)
    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    const folders = h.google.folders.size
    const projectFolder = projectRow(h, projectId).driveProjectFolderId
    const connection = structuredClone(h.store.tables.drive_connections)

    expect(await signIn(h, 1, 'rt-1b')).toBe('ok')

    expect(accountOf(h, 1).tokenStatus).toBe('valid')
    expect(h.store.tables.google_accounts).toHaveLength(1)
    expect(h.store.tables.drive_connections).toEqual(connection)
    expect(projectRow(h, projectId).driveProjectFolderId).toBe(projectFolder)
    expect(groupFolderId(h, groupId)).not.toBeNull()
    expect(h.google.folders.size).toBe(folders) // verified, none made
    expect(h.line.pushes).toHaveLength(1) // only the earlier card
  })

  it('a later revocation of the new grant posts again, under a new retry key', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    h.setNow(new Date(TEST_NOW.getTime() + 60 * MIN))
    expect(await signIn(h, 1, 'rt-1b')).toBe('ok')
    h.google.revokedRefreshTokens.add('rt-1b')
    await ensureDriveFolders(h.deps, projectId, fullTime(h))

    expect(h.line.delivered).toHaveLength(2)
    expect(h.line.pushes[0].retryKey).not.toBe(h.line.pushes[1].retryKey)
  })

  it('with too little time left for the card, leaves the account valid so a later run marks it and posts', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    h.google.callMs = DRIVE_CALL_MAX_MS
    // Time for the refresh, but not for the two LINE steps of the card after it.
    const start = h.deps.now()
    h.setNow(new Date(start.getTime() + DRIVE_HARD_STOP_MS - 2.5 * DRIVE_CALL_MAX_MS))
    await expect(ensureDriveFolders(h.deps, projectId, driveDeadline(start))).rejects.toMatchObject({ name: 'DriveTimeUp' })
    expect(accountOf(h, 1).tokenStatus).toBe('valid')
    expect(h.line.pushes).toEqual([])

    h.google.callMs = 0
    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    expect(accountOf(h, 1).tokenStatus).toBe('revoked')
    expect(h.line.pushes).toHaveLength(1)
  })

  it('near the monthly LINE quota the card is skipped; the account is still marked', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    h.line.quota = { limit: 300, used: 299 }
    await ensureDriveFolders(h.deps, projectId, fullTime(h))

    expect(accountOf(h, 1).tokenStatus).toBe('revoked')
    expect(h.line.pushes).toEqual([])
    expect(h.store.tables.push_log).toEqual([])
  })

  it('logs IDs only: no token, e-mail or name', async () => {
    const h = setup()
    const { projectId } = await connectedThenRevoked(h)
    await ensureDriveFolders(h.deps, projectId, fullTime(h))

    expect(infoEvents()).toContainEqual({
      event: 'drive_access_lost', projectId, googleAccountId: accountOf(h, 1).id, prompt: 'pushed',
    })
    for (const secret of ['rt-1', 'owner1@example.com', 'Owner Name', 'ทีมหลัก']) expect(logged()).not.toContain(secret)
  })
})

describe('change of Google account', () => {
  const activeRows = (h: H, projectId: string) =>
    h.store.tables.drive_connections.filter((c) => c.projectId === projectId && c.status === 'active')
  const madeWith = (h: H, folderId: string | null | undefined) => (folderId ? h.google.folders.get(folderId)?.createdWith : undefined)

  it('a sign-in with another account retires the old connection as history, clears the folder IDs and lays out new folders in the new Drive', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    expect(await signIn(h, 1)).toBe('ok')
    h.store.seedTask({ groupId, title: 'ส่งรายงาน', createdByLineUserId: OWNER })
    const tasksBefore = structuredClone(h.store.tables.tasks)
    const oldConnection = structuredClone(h.store.tables.drive_connections[0])
    const oldProjectFolder = projectRow(h, projectId).driveProjectFolderId as string
    const oldGroupFolder = groupFolderId(h, groupId) as string
    const oldDrive = [...h.google.folders.keys()]

    h.setNow(new Date(TEST_NOW.getTime() + 60 * MIN))
    expect(await signIn(h, 2)).toBe('ok')

    // The old row is kept as it was, only retired: what a saved file's drive_connection_id
    // points at still names the Project and the old Google account.
    expect(h.store.tables.drive_connections).toHaveLength(2)
    expect(h.store.tables.drive_connections[0]).toEqual({ ...oldConnection, status: 'replaced', statusChangedAt: h.deps.now() })
    expect(oldConnection.googleAccountId).toBe(accountOf(h, 1).id)
    // One active connection, held by the new account.
    expect(activeRows(h, projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 2).id })])
    // The folder IDs were cleared and the new account made its own tree.
    const newProjectFolder = projectRow(h, projectId).driveProjectFolderId
    expect(newProjectFolder).not.toBe(oldProjectFolder)
    expect(groupFolderId(h, groupId)).not.toBe(oldGroupFolder)
    expect(madeWith(h, newProjectFolder)).toBe('at:rt-2')
    expect(madeWith(h, groupFolderId(h, groupId))).toBe('at:rt-2')
    expect(madeWith(h, accountOf(h, 2).driveRootFolderId)).toBe('at:rt-2')
    expect(h.google.driveCalls).toContain(`share:${newProjectFolder}`)
    // Nothing in the old Drive was deleted, moved or trashed; the old account keeps its root.
    for (const id of oldDrive) expect(h.google.folders.get(id)).toMatchObject({ createdWith: 'at:rt-1' })
    expect(await h.google.getFolder('at:rt-1', oldProjectFolder)).toBe('ok')
    expect(madeWith(h, accountOf(h, 1).driveRootFolderId)).toBe('at:rt-1')
    // Tasks are untouched, and nothing was pushed.
    expect(h.store.tables.tasks).toEqual(tasksBefore)
    expect(h.line.pushes).toEqual([])
    expect(infoEvents()).toContainEqual({ event: 'drive_account_changed', googleAccountId: accountOf(h, 2).id, projects: 1 })
    for (const secret of ['rt-2', 'owner2@example.com', 'Owner Name', 'ทีมหลัก']) expect(logged()).not.toContain(secret)
  })

  it('retires and clears before the page is answered, for every group of the Project', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    const sub = h.store.seedGroup({ lineGroupId: 'Csub1', name: 'ทีมย่อย', projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
    expect(await signIn(h, 1)).toBe('ok')
    // A Sub group that waits for its Owner again still holds a folder ID from the old Drive.
    h.store.tables.groups.find((g) => g.id === sub.id)!.ownerConfirmedAt = null
    expect(groupFolderId(h, sub.id)).not.toBeNull()

    h.google.exchangeResult = { ...(h.google.exchangeResult as object), subject: 'g-sub-2', refreshToken: 'rt-2' } as never
    const res = await startGoogleSignIn(h.deps, { idToken: OWNER_TOKEN })
    const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
    expect(await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'c', state }), h.defer)).toBe('ok')

    // The deferred Drive work has not run yet.
    expect(activeRows(h, projectId)).toEqual([])
    expect(projectRow(h, projectId).driveProjectFolderId).toBeNull()
    expect(groupFolderId(h, groupId)).toBeNull()
    expect(groupFolderId(h, sub.id)).toBeNull()
    expect(h.store.tables.drive_connections).toEqual([expect.objectContaining({ status: 'replaced' })])
  })

  it('a sign-in with the same account changes nothing', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    expect(await signIn(h, 1)).toBe('ok')
    const connections = structuredClone(h.store.tables.drive_connections)
    const projectFolder = projectRow(h, projectId).driveProjectFolderId
    const groupFolder = groupFolderId(h, groupId)
    const folders = h.google.folders.size

    h.setNow(new Date(TEST_NOW.getTime() + 60 * MIN))
    expect(await signIn(h, 1, 'rt-1b')).toBe('ok')

    expect(h.store.tables.drive_connections).toEqual(connections)
    expect(projectRow(h, projectId).driveProjectFolderId).toBe(projectFolder)
    expect(groupFolderId(h, groupId)).toBe(groupFolder)
    expect(h.google.folders.size).toBe(folders)
    expect(infoEvents().map((e) => e.event)).not.toContain('drive_account_changed')
  })

  it('changes every Project the signer owns as confirmed Owner, and no one else\'s', async () => {
    const h = setup()
    const first = await seedProject(h)
    const second = await seedProject(h, 'Cmain2')
    expect(await signIn(h, 1)).toBe('ok')
    // Another Owner's Project, connected to that Owner's own Google account.
    const other = h.store.seedGroup({ lineGroupId: 'Cother', name: 'ทีมอื่น', nominatedOwnerLineUserId: 'Uother' })
    h.store.seedMember({ groupId: other.id, lineUserId: 'Uother', displayName: 'Other' })
    expect((await h.store.confirmGroupOwner(other.id, 'Uother', TEST_NOW)).outcome).toBe('confirmed')
    const otherProject = h.store.tables.groups.find((g) => g.id === other.id)!.projectId as string
    const { id: otherAccount } = await h.store.upsertGoogleAccount({
      lineUserId: 'Uother', googleSubject: 'g-sub-other', email: null, grantedScopes: [],
      refreshTokenCiphertext: seal('rt-other', TEST_KEY), signedInAt: h.deps.now(),
    })
    await ensureDriveFolders(h.deps, otherProject, fullTime(h))
    const otherFolder = projectRow(h, otherProject).driveProjectFolderId

    expect(await signIn(h, 2)).toBe('ok')

    for (const p of [first, second]) {
      expect(activeRows(h, p.projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 2).id })])
      expect(madeWith(h, projectRow(h, p.projectId).driveProjectFolderId)).toBe('at:rt-2')
    }
    expect(activeRows(h, otherProject)).toEqual([expect.objectContaining({ googleAccountId: otherAccount })])
    expect(projectRow(h, otherProject).driveProjectFolderId).toBe(otherFolder)
    expect(infoEvents()).toContainEqual({ event: 'drive_account_changed', googleAccountId: accountOf(h, 2).id, projects: 2 })
  })

  it('is safely repeatable: a change that failed part-way is finished by the next sign-in', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    expect(await signIn(h, 1)).toBe('ok')

    // The store fails while it retires: the page says failed and no Drive work starts.
    h.store.failNext('retireDriveConnection')
    expect(await signIn(h, 2)).toBe('failed')
    expect(h.google.refreshCalls).not.toContain('rt-2')
    // Worst case of the real store's three statements: the folder IDs are already cleared
    // and the old row is still active.
    h.store.tables.projects.find((p) => p.id === projectId)!.driveProjectFolderId = null
    h.store.tables.group_setups.find((r) => r.groupId === groupId)!.driveFolderId = null
    expect(activeRows(h, projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 1).id })])

    expect(await signIn(h, 2)).toBe('ok')

    expect(h.store.tables.drive_connections.map((c) => c.status).sort()).toEqual(['active', 'replaced'])
    expect(activeRows(h, projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 2).id })])
    expect(madeWith(h, projectRow(h, projectId).driveProjectFolderId)).toBe('at:rt-2')
    expect(madeWith(h, groupFolderId(h, groupId))).toBe('at:rt-2')
  })

  it('the tick finishes the new folders when the sign-in ran out of time', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    expect(await signIn(h, 1)).toBe('ok')
    h.setNow(new Date(TEST_NOW.getTime() + 60 * MIN))
    h.google.callMs = DRIVE_CALL_MAX_MS
    expect(await signIn(h, 2)).toBe('ok') // the exchange and four folder calls do not fit
    expect(groupFolderId(h, groupId)).toBeNull()

    h.google.callMs = 0
    h.setNow(new Date(TEST_NOW.getTime() + 75 * MIN))
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [driveSetupJob])).status).toBe(200)
    await h.runDeferred()

    expect(activeRows(h, projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 2).id })])
    expect(madeWith(h, groupFolderId(h, groupId))).toBe('at:rt-2')
  })

  it('changing away from a revoked account works the same, and the new account is valid', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    expect(await signIn(h, 1)).toBe('ok')
    h.google.revokedRefreshTokens.add('rt-1')
    await ensureDriveFolders(h.deps, projectId, fullTime(h))
    expect(accountOf(h, 1).tokenStatus).toBe('revoked')

    h.setNow(new Date(TEST_NOW.getTime() + 60 * MIN))
    expect(await signIn(h, 2)).toBe('ok')

    expect(await h.store.findGoogleAccountByLineUser(OWNER)).toMatchObject({ id: accountOf(h, 2).id, tokenStatus: 'valid' })
    expect(activeRows(h, projectId)).toEqual([expect.objectContaining({ googleAccountId: accountOf(h, 2).id })])
    expect(accountOf(h, 1).tokenStatus).toBe('revoked') // history: the old account row stays as it was
  })
})
