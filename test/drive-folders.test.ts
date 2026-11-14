import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { finishGoogleSignIn } from '@/server/google/callback'
import {
  DRIVE_CALL_MAX_MS, DRIVE_HARD_STOP_MS, driveDeadline, driveSetupJob, DriveTimeUp, ensureDriveFolders,
  ensureGroupFolder, FINISH_AFTER_MS, FINISH_WITHIN_MS, MAIN_GROUP_FOLDER, ROOT_FOLDER,
} from '@/server/google/drive-folders'
import { startGoogleSignIn } from '@/server/google/start'
import { AdapterError } from '@/server/log'
import { seal } from '@/server/crypto/secretbox'
import { confirmOwner } from '@/server/setup/confirm'
import { submitSetup } from '@/server/setup/submit'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { TickJob } from '@/server/tick/run-tick'
import { makeTestDeps, TEST_KEY, TEST_NOW, tickRequest } from './harness'

// #13 acceptance: after Google sign-in (and an Owner confirm), the Owner's Drive gets
// NongJoDII/<main group>/Main group files and one folder per Sub group, IDs stored,
// the Project folder shared once, and one active Drive connection.

const OWNER = 'Uowner1'
const OWNER_TOKEN = 'idtok-owner'
const MAIN_LINE_GROUP = 'Cmain'

let infos: MockInstance<typeof console.info>
let errors: MockInstance<typeof console.error>
beforeEach(() => {
  infos = vi.spyOn(console, 'info').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function errorEvents(): Record<string, unknown>[] {
  return errors.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}
function infoEvents(): Record<string, unknown>[] {
  return infos.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}

type H = ReturnType<typeof makeTestDeps>

/** The deadline of a request that starts now: the whole time a route allows. */
const fullTime = (h: H) => driveDeadline(h.deps.now())

function setup() {
  const h = makeTestDeps()
  h.line.idTokens.set(OWNER_TOKEN, { lineUserId: OWNER, displayName: 'Owner Name' })
  return h
}

/** A main group named `name` whose nominee OWNER confirms: this creates the Project. */
async function seedProject(h: H, p?: { name?: string | null; lineGroupId?: string; owner?: string }) {
  const owner = p?.owner ?? OWNER
  const g = h.store.seedGroup({
    lineGroupId: p?.lineGroupId ?? MAIN_LINE_GROUP, name: p?.name === undefined ? 'ทีมหลัก' : p.name,
    nominatedOwnerLineUserId: owner,
  })
  h.store.seedMember({ groupId: g.id, lineUserId: owner, displayName: 'Owner Name' })
  expect((await h.store.confirmGroupOwner(g.id, owner, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
  return { groupId: g.id, projectId }
}

/** A Sub group attached to the Project, its Owner confirmed. */
function seedSubGroup(h: H, projectId: string, p: { lineGroupId: string; name: string | null; confirmed?: boolean }) {
  const g = h.store.seedGroup({
    lineGroupId: p.lineGroupId, name: p.name, projectId, nominatedOwnerLineUserId: OWNER,
    ownerConfirmedAt: p.confirmed === false ? null : TEST_NOW,
  })
  return g.id
}

/** Google sign-in from start to callback; the deferred Drive work stays queued. */
async function finishSignIn(h: H) {
  const res = await startGoogleSignIn(h.deps, { idToken: OWNER_TOKEN })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  return finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'code-1', state }), h.defer)
}

/** Google sign-in from start to callback, then the deferred Drive work. */
async function signIn(h: H) {
  const outcome = await finishSignIn(h)
  await h.runDeferred()
  return outcome
}

const account = (h: H) => h.store.tables.google_accounts[0]
const projectRow = (h: H, id: string) => h.store.tables.projects.find((p) => p.id === id)!
const groupFolderId = (h: H, groupId: string) => h.store.tables.group_setups.find((r) => r.groupId === groupId)?.driveFolderId ?? null
const projectOf = (h: H, groupId: string) => h.store.tables.groups.find((r) => r.id === groupId)!.projectId as string

/** Every folder ID the store holds. */
const storedFolderIds = (h: H) => [
  ...h.store.tables.google_accounts.map((a) => a.driveRootFolderId),
  ...h.store.tables.projects.map((p) => p.driveProjectFolderId),
  ...h.store.tables.group_setups.map((r) => r.driveFolderId),
].filter((id): id is string => !!id).sort()
/** Every folder in the fake Drive. Equal to storedFolderIds: no folder was left behind. */
const driveFolderIds = (h: H) => [...h.google.folders.keys()].sort()

/** A main group whose nominee OWNER already signed in to Google. */
async function seedSignedInNominee(h: H) {
  const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
  h.line.groupMemberCounts.set(MAIN_LINE_GROUP, 1)
  await h.store.upsertGoogleAccount({
    lineUserId: OWNER, googleSubject: 'g-sub-1', email: null,
    grantedScopes: ['https://www.googleapis.com/auth/drive.file'], refreshTokenCiphertext: seal('rt-1', TEST_KEY),
  })
  return g.id
}

/** The setup form, sent by OWNER naming themselves as Owner: this confirms them at once. */
const selfConfirmForm = (groupId: string) => ({
  idToken: OWNER_TOKEN, groupId, workDescription: 'งาน',
  features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
  dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
  members: [{ lineUserId: OWNER, nicknames: [], role: '' }], ownerLineUserId: OWNER,
})

describe('first sign-in', () => {
  it('creates NongJoDII/<main group>/Main group files, stores the IDs, shares the Project folder once and records one active connection', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    expect(await signIn(h)).toBe('ok')

    const [root] = h.google.foldersNamed(ROOT_FOLDER, null)
    expect(ROOT_FOLDER).toBe('NongJoDII')
    expect(h.google.foldersNamed(ROOT_FOLDER)).toHaveLength(1)
    const [projectFolder] = h.google.foldersNamed('ทีมหลัก', root.id)
    const [mainFolder] = h.google.foldersNamed(MAIN_GROUP_FOLDER, projectFolder.id)
    expect(MAIN_GROUP_FOLDER).toBe('Main group files')
    expect(h.google.folders.size).toBe(3)

    // IDs are stored, never names.
    expect(account(h).driveRootFolderId).toBe(root.id)
    expect(projectRow(h, projectId).driveProjectFolderId).toBe(projectFolder.id)
    expect(groupFolderId(h, groupId)).toBe(mainFolder.id)

    expect(h.google.shares).toEqual([{ fileId: projectFolder.id, role: 'reader', type: 'anyone' }])
    expect(h.store.tables.drive_connections).toEqual([
      { id: expect.any(String), projectId, googleAccountId: account(h).id, status: 'active' },
    ])
    expect(h.google.refreshCalls).toEqual(['rt-1'])
  })

  it('creates a folder for every attached, confirmed Sub group, and none for an unconfirmed one', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: 'ทีมย่อย' })
    const pending = seedSubGroup(h, projectId, { lineGroupId: 'Csub2', name: 'รอยืนยัน', confirmed: false })
    await signIn(h)
    const projectFolderId = projectRow(h, projectId).driveProjectFolderId as string
    const [subFolder] = h.google.foldersNamed('ทีมย่อย', projectFolderId)
    expect(groupFolderId(h, sub)).toBe(subFolder.id)
    expect(groupFolderId(h, pending)).toBeNull()
    expect(h.google.foldersNamed('รอยืนยัน')).toHaveLength(0)
    expect(h.google.shares).toHaveLength(1) // the Sub group folder inherits the Project's sharing
  })

  it('lays out every Project the signer owns under one root', async () => {
    const h = setup()
    const a = await seedProject(h, { name: 'โปรเจกต์ A', lineGroupId: 'Ca' })
    const b = await seedProject(h, { name: 'โปรเจกต์ B', lineGroupId: 'Cb' })
    await signIn(h)
    const [root] = h.google.foldersNamed(ROOT_FOLDER)
    expect(h.google.foldersNamed(ROOT_FOLDER)).toHaveLength(1)
    expect(h.google.foldersNamed('โปรเจกต์ A', root.id)).toHaveLength(1)
    expect(h.google.foldersNamed('โปรเจกต์ B', root.id)).toHaveLength(1)
    expect(h.google.shares.map((s) => s.fileId).sort()).toEqual(
      [projectRow(h, a.projectId).driveProjectFolderId, projectRow(h, b.projectId).driveProjectFolderId].sort(),
    )
    expect(h.store.tables.drive_connections).toHaveLength(2)
  })
})

describe('later runs', () => {
  it('a second sign-in creates and shares nothing and keeps one connection', async () => {
    const h = setup()
    await seedProject(h)
    await signIn(h)
    const before = h.google.folders.size
    h.google.driveCalls = []
    await signIn(h)
    expect(h.google.folders.size).toBe(before)
    expect(h.google.driveCalls.filter((c) => !c.startsWith('get:'))).toEqual([])
    expect(h.google.shares).toHaveLength(1)
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })

  it('a trashed Project folder is recreated, shared again, and gets a new Main group files folder', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    await signIn(h)
    const rootId = account(h).driveRootFolderId as string
    const oldProject = projectRow(h, projectId).driveProjectFolderId as string
    const oldMain = groupFolderId(h, groupId) as string
    h.google.trash(oldProject)
    await signIn(h)
    const newProject = projectRow(h, projectId).driveProjectFolderId as string
    expect(newProject).not.toBe(oldProject)
    expect(h.google.folders.get(newProject)).toMatchObject({ name: 'ทีมหลัก', parentId: rootId, trashed: false })
    expect(h.google.shares.map((s) => s.fileId)).toEqual([oldProject, newProject])
    const newMain = groupFolderId(h, groupId) as string
    expect(newMain).not.toBe(oldMain)
    expect(h.google.folders.get(newMain)).toMatchObject({ name: MAIN_GROUP_FOLDER, parentId: newProject })
    expect(account(h).driveRootFolderId).toBe(rootId) // the root was fine
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })

  it('a root folder deleted for good is recreated with the whole tree under it', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    await signIn(h)
    const oldRoot = account(h).driveRootFolderId as string
    const oldProject = projectRow(h, projectId).driveProjectFolderId as string
    // Emptied from the trash: the root and everything in it are gone (404).
    for (const f of [...h.google.folders.values()]) h.google.remove(f.id)
    await signIn(h)
    const newRoot = account(h).driveRootFolderId as string
    expect(newRoot).not.toBe(oldRoot)
    expect(h.google.folders.get(newRoot)).toMatchObject({ name: ROOT_FOLDER, parentId: null })
    const newProject = projectRow(h, projectId).driveProjectFolderId as string
    expect(h.google.folders.get(newProject)?.parentId).toBe(newRoot)
    expect(h.google.folders.get(groupFolderId(h, groupId) as string)?.parentId).toBe(newProject)
    expect(h.google.shares.map((s) => s.fileId)).toEqual([oldProject, newProject])
  })

  it('a trashed group folder alone is recreated, without sharing again', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    await signIn(h)
    const projectFolder = projectRow(h, projectId).driveProjectFolderId as string
    const oldMain = groupFolderId(h, groupId) as string
    h.google.trash(oldMain)
    await signIn(h)
    expect(groupFolderId(h, groupId)).not.toBe(oldMain)
    expect(h.google.folders.get(groupFolderId(h, groupId) as string)?.parentId).toBe(projectFolder)
    expect(projectRow(h, projectId).driveProjectFolderId).toBe(projectFolder)
    expect(h.google.shares).toHaveLength(1)
  })
})

describe('ensureGroupFolder (a Sub group attached later)', () => {
  it('creates only that group\'s folder under the existing Project folder', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    const before = h.google.folders.size
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: 'ทีมย่อย' })
    const id = await ensureGroupFolder(h.deps, sub, fullTime(h))
    expect(id).toBe(groupFolderId(h, sub))
    expect(h.google.folders.get(id as string)).toMatchObject({
      name: 'ทีมย่อย', parentId: projectRow(h, projectId).driveProjectFolderId,
    })
    expect(h.google.folders.size).toBe(before + 1)
    expect(h.google.shares).toHaveLength(1)
    // Again: the stored folder is kept.
    expect(await ensureGroupFolder(h.deps, sub, fullTime(h))).toBe(id)
    expect(h.google.folders.size).toBe(before + 1)
  })

  it('builds the root and Project folders first when they are not there yet', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    h.google.trash(account(h).driveRootFolderId as string)
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: 'ทีมย่อย' })
    const id = await ensureGroupFolder(h.deps, sub, fullTime(h))
    const root = account(h).driveRootFolderId as string
    const project = projectRow(h, projectId).driveProjectFolderId as string
    expect(h.google.folders.get(root)?.trashed).toBe(false)
    expect(h.google.folders.get(project)?.parentId).toBe(root)
    expect(h.google.folders.get(id as string)?.parentId).toBe(project)
    expect(h.google.shares.map((s) => s.fileId)).toContain(project)
  })

  it('answers null for a group with no Project or no confirmed Owner, with no Drive call', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    h.google.driveCalls = []
    const loose = h.store.seedGroup({ lineGroupId: 'Cloose' })
    const pending = seedSubGroup(h, projectId, { lineGroupId: 'Cpend', name: 'x', confirmed: false })
    expect(await ensureGroupFolder(h.deps, loose.id, fullTime(h))).toBeNull()
    expect(await ensureGroupFolder(h.deps, pending, fullTime(h))).toBeNull()
    expect(h.google.driveCalls).toEqual([])
  })
})

describe('folder names', () => {
  it('a main group with no stored name takes its LINE name from the group summary', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h, { name: null })
    h.line.groupNames.set(MAIN_LINE_GROUP, 'ชื่อจาก LINE')
    await signIn(h)
    expect(h.google.folders.get(projectRow(h, projectId).driveProjectFolderId as string)?.name).toBe('ชื่อจาก LINE')
    expect(h.store.tables.groups.find((g) => g.id === groupId)?.name).toBe('ชื่อจาก LINE')
  })

  it('falls back to a neutral label when LINE has no name either', async () => {
    const h = setup()
    const { projectId } = await seedProject(h, { name: null })
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: null })
    h.line.failGroupSummary = true
    await signIn(h)
    expect(h.google.folders.get(projectRow(h, projectId).driveProjectFolderId as string)?.name).toBe('Project')
    expect(h.google.folders.get(groupFolderId(h, sub) as string)?.name).toBe('Sub group')
  })
})

describe('failures and skips', () => {
  it('a Drive error keeps the account stored and the outcome ok, and is logged', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    h.google.driveError = new AdapterError('google drive create 500')
    expect(await signIn(h)).toBe('ok')
    expect(h.store.tables.google_accounts).toHaveLength(1)
    expect(account(h).tokenStatus).toBe('valid')
    expect(errorEvents()).toContainEqual({ event: 'drive_folders_failed', projectId, error: 'google drive create 500' })
    expect(h.store.tables.drive_connections).toHaveLength(0)
    // The next sign-in finishes the job.
    h.google.driveError = null
    await signIn(h)
    expect(h.google.folders.size).toBe(3)
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })

  it('a revoked grant is logged as such and stops before any Drive call', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    h.google.revokedRefreshTokens.add('rt-1')
    expect(await signIn(h)).toBe('ok')
    expect(h.google.driveCalls).toEqual([])
    expect(errorEvents()).toContainEqual({ event: 'drive_folders_failed', projectId, error: 'google refresh invalid_grant' })
  })

  it('a store failure in the Drive job is logged and the outcome stays ok', async () => {
    const h = setup()
    await seedProject(h)
    h.store.failNext('listConfirmedOwnerProjects')
    expect(await signIn(h)).toBe('ok')
    expect(errorEvents().map((e) => e.event)).toContain('drive_sync_failed')
    expect(h.google.driveCalls).toEqual([])
  })

  it('a signer with no confirmed Project gets no Drive call', async () => {
    const h = setup()
    // Nominated but not confirmed: no Project yet.
    const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'x', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect(await signIn(h)).toBe('ok')
    expect(h.google.refreshCalls).toEqual([])
    expect(h.google.driveCalls).toEqual([])
    expect(h.store.tables.drive_connections).toHaveLength(0)
  })

  it('a Project whose active connection is another Google account is left alone', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    const before = h.google.folders.size
    // Same LINE user, a second Google account.
    h.google.exchangeResult = { ...h.google.exchangeResult as object, subject: 'g-sub-2', refreshToken: 'rt-2' } as never
    h.google.driveCalls = []
    await signIn(h)
    expect(h.store.tables.google_accounts).toHaveLength(2)
    expect(h.google.driveCalls).toEqual([])
    expect(h.google.folders.size).toBe(before)
    expect(h.store.tables.drive_connections).toEqual([expect.objectContaining({ projectId, status: 'active' })])
  })

  it('two runs at once store one ID per folder and the stored folders form one tree', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    await signIn(h) // the account exists; now lose every folder and run twice at once
    for (const f of [...h.google.folders.values()]) h.google.remove(f.id)
    await Promise.all([ensureDriveFolders(h.deps, projectId, fullTime(h)), ensureDriveFolders(h.deps, projectId, fullTime(h))])
    const root = account(h).driveRootFolderId as string
    const project = projectRow(h, projectId).driveProjectFolderId as string
    expect(h.google.folders.get(project)?.parentId).toBe(root)
    expect(h.google.folders.get(groupFolderId(h, groupId) as string)?.parentId).toBe(project)
    expect(h.google.shares.map((s) => s.fileId)).toContain(project)
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })
})

describe('Owner confirm', () => {
  it('an Owner who already connected Google gets the folders when they confirm', async () => {
    const h = setup()
    await signIn(h) // connected first, no Project yet: nothing in Drive
    expect(h.google.folders.size).toBe(0)
    const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    const res = await confirmOwner(h.deps, { idToken: OWNER_TOKEN, groupId: g.id }, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
    const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
    expect(h.google.folders.get(projectRow(h, projectId).driveProjectFolderId as string)?.name).toBe('ทีมหลัก')
    expect(groupFolderId(h, g.id)).not.toBeNull()
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })

  it('an Owner without a Google account confirms with no Drive call', async () => {
    const h = setup()
    const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await confirmOwner(h.deps, { idToken: OWNER_TOKEN, groupId: g.id }, h.defer)).status).toBe(200)
    await h.runDeferred()
    expect(h.google.refreshCalls).toEqual([])
    expect(h.google.driveCalls).toEqual([])
  })

  it('an Owner who names themselves in the setup form, already signed in to Google, gets the folders', async () => {
    const h = setup()
    const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก' })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    h.line.groupMemberCounts.set(MAIN_LINE_GROUP, 1)
    await h.store.upsertGoogleAccount({
      lineUserId: OWNER, googleSubject: 'g-sub-1', email: null,
      grantedScopes: ['https://www.googleapis.com/auth/drive.file'], refreshTokenCiphertext: seal('rt-1', TEST_KEY),
    })
    const res = await submitSetup(h.deps, {
      idToken: OWNER_TOKEN, groupId: g.id, workDescription: 'งาน',
      features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
      members: [{ lineUserId: OWNER, nicknames: ['โอ'], role: 'PM' }], ownerLineUserId: OWNER,
    }, h.defer)
    expect(res).toMatchObject({ status: 200, body: { state: 'confirmed' } })
    expect(h.google.folders.size).toBe(0) // nothing before the response
    await h.runDeferred()
    const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
    expect(h.google.folders.get(projectRow(h, projectId).driveProjectFolderId as string)?.name).toBe('ทีมหลัก')
    expect(groupFolderId(h, g.id)).not.toBeNull()
    expect(h.google.shares).toHaveLength(1)
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })
})

describe('time limit: each route allows 60 s, its after() work included', () => {
  /** No Google call started too late to end by the hard stop if it ran to its 10 s timeout. */
  const expectEveryCallInTime = (h: H, requestStart: number) => {
    expect(h.google.callLog.length).toBeGreaterThan(0)
    for (const c of h.google.callLog) {
      expect(c.at + DRIVE_CALL_MAX_MS).toBeLessThanOrEqual(requestStart + DRIVE_HARD_STOP_MS)
    }
  }

  it('with 5 s Drive calls, starts no call that could end late, leaves no folder behind, and the next sign-in finishes', async () => {
    const h = setup()
    for (const [name, lineGroupId] of [['A', 'Ca'], ['B', 'Cb'], ['C', 'Cc']]) await seedProject(h, { name, lineGroupId })
    const order = await h.store.listConfirmedOwnerProjects(OWNER) // the order the sync walks
    h.google.callMs = 5_000
    const start = h.deps.now().getTime()
    expect(await signIn(h)).toBe('ok')

    expectEveryCallInTime(h, start)
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
    // A stored Project folder is always a shared one.
    for (const p of h.store.tables.projects.filter((x) => x.driveProjectFolderId)) {
      expect(h.google.shares.map((s) => s.fileId)).toContain(p.driveProjectFolderId)
    }
    // The first Project is done. The second stopped before its root folder step, and the
    // stop is logged once, with the IDs and counts only.
    expect(h.store.tables.drive_connections.map((c) => c.projectId)).toEqual([order[0]])
    expect(infoEvents().filter((e) => e.event === 'drive_sync_incomplete')).toEqual([
      { event: 'drive_sync_incomplete', projectId: order[1], projectsLeft: 2 },
    ])
    expect(errorEvents()).toEqual([])

    h.google.callMs = 0
    await signIn(h)
    expect(h.store.tables.drive_connections).toHaveLength(3)
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
  })

  it('with every call running to its 10 s timeout, the last call still ends by the hard stop', async () => {
    const h = setup()
    const { groupId, projectId } = await seedProject(h)
    h.google.callMs = DRIVE_CALL_MAX_MS
    const start = h.deps.now().getTime()
    await signIn(h)
    const last = h.google.callLog.at(-1)!
    expect(last.at + DRIVE_CALL_MAX_MS).toBeLessThanOrEqual(start + DRIVE_HARD_STOP_MS)
    // The code exchange, the refresh, the root and the shared Project folder fit. The Main
    // group files step would have run past the hard stop, so it never started.
    expect(h.google.callLog.map((c) => c.call.split(':')[0])).toEqual(['exchange', 'refresh', 'create', 'create', 'share'])
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
    expect(groupFolderId(h, groupId)).toBeNull()
    expect(h.store.tables.drive_connections).toHaveLength(0)
    expect(infoEvents()).toContainEqual({ event: 'drive_sync_incomplete', projectId, projectsLeft: 1 })
  })

  it('checks each folder step, so one Project with many Sub groups stops in time too', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    for (let i = 1; i <= 6; i++) seedSubGroup(h, projectId, { lineGroupId: `Csub${i}`, name: `ทีมย่อย ${i}` })
    h.google.callMs = 5_000
    const start = h.deps.now().getTime()
    await signIn(h)
    expectEveryCallInTime(h, start)
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
    // The root, the Project, Main group files and 3 of the 6 Sub groups. The connection
    // comes last, so the Project still counts as unfinished.
    expect(h.google.folders.size).toBe(6)
    expect(h.store.tables.drive_connections).toHaveLength(0)
    expect(infoEvents()).toContainEqual({ event: 'drive_sync_incomplete', projectId, projectsLeft: 1 })
  })

  it.each([
    { name: 'ทีมหลัก', made: true },
    { name: null, made: false },
  ])('counts the LINE name lookup in the Project folder step (stored name: $name)', async ({ name, made }) => {
    const h = setup()
    const { projectId } = await seedProject(h, { name })
    h.line.groupNames.set(MAIN_LINE_GROUP, 'ชื่อจาก LINE')
    await finishSignIn(h)
    // 25 s left when the after() work starts: enough for the refresh, the root folder and a
    // named Project folder (create, share); not for one that asks LINE for its name first.
    h.setNow(new Date(TEST_NOW.getTime() + DRIVE_HARD_STOP_MS - 25_000))
    await h.runDeferred()
    expect(Boolean(projectRow(h, projectId).driveProjectFolderId)).toBe(made)
    expect(h.line.groupSummaryCalls).toEqual([])
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
  })

  it('counts from the start of the setup form request, not from its after() work', async () => {
    const h = setup()
    const groupId = await seedSignedInNominee(h)
    const res = await submitSetup(h.deps, selfConfirmForm(groupId), h.defer)
    expect(res).toMatchObject({ status: 200, body: { state: 'confirmed' } })
    // The handler's LINE calls (access check, push budget, push) took 50 s: 5 s are left.
    h.setNow(new Date(TEST_NOW.getTime() + 50_000))
    await h.runDeferred()
    expect(h.google.callLog).toEqual([])
    expect(infoEvents()).toContainEqual({ event: 'drive_sync_incomplete', projectId: projectOf(h, groupId), projectsLeft: 1 })
  })

  it('counts from the start of the Owner confirm request, not from its after() work', async () => {
    const h = setup()
    const groupId = await seedSignedInNominee(h)
    expect((await confirmOwner(h.deps, { idToken: OWNER_TOKEN, groupId }, h.defer)).status).toBe(200)
    h.setNow(new Date(TEST_NOW.getTime() + 50_000))
    await h.runDeferred()
    expect(h.google.callLog).toEqual([])
    expect(infoEvents()).toContainEqual({ event: 'drive_sync_incomplete', projectId: projectOf(h, groupId), projectsLeft: 1 })
  })

  it('ensureGroupFolder throws DriveTimeUp before any call when its caller has too little time left', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: 'ทีมย่อย' })
    h.google.callLog = []
    const almostOver = new Date(h.deps.now().getTime() + 5_000)
    await expect(ensureGroupFolder(h.deps, sub, almostOver)).rejects.toBeInstanceOf(DriveTimeUp)
    expect(h.google.callLog).toEqual([])
    expect(groupFolderId(h, sub)).toBeNull()
  })
})

describe('tick finisher: the 15-minute tick finishes what a request could not', () => {
  const MIN = 60_000
  const after = (ms: number) => new Date(TEST_NOW.getTime() + ms)

  /** One tick at `at`: the route answers, then its jobs run (every tick job unless `jobs` is given). */
  async function tick(h: H, at: Date, jobs?: TickJob[]) {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, jobs)).status).toBe(200)
    await h.runDeferred()
  }

  it('finishes, tick by tick, the Projects a slow sign-in ran out of time for', async () => {
    const h = setup()
    for (const [name, lineGroupId] of [['A', 'Ca'], ['B', 'Cb'], ['C', 'Cc']]) await seedProject(h, { name, lineGroupId })
    h.google.callMs = 5_000
    await signIn(h)
    expect(h.store.tables.drive_connections).toHaveLength(1)

    // With 5 s calls one tick has time for one more Project; the next tick does the last.
    await tick(h, after(15 * MIN))
    expect(h.store.tables.drive_connections).toHaveLength(2)
    await tick(h, after(30 * MIN))
    expect(h.store.tables.drive_connections).toHaveLength(3)
    expect(driveFolderIds(h)).toEqual(storedFolderIds(h))
    expect(h.google.shares).toHaveLength(3)
    // Timed from the tick's start like a request: no call could run past its hard stop.
    for (const c of h.google.callLog.filter((x) => x.at >= after(15 * MIN).getTime())) {
      const tickStart = c.at < after(30 * MIN).getTime() ? after(15 * MIN) : after(30 * MIN)
      expect(c.at + DRIVE_CALL_MAX_MS).toBeLessThanOrEqual(tickStart.getTime() + DRIVE_HARD_STOP_MS)
    }
  })

  it('finishes the folders of an Owner who named themselves in a setup form too slow to make them', async () => {
    const h = setup()
    const groupId = await seedSignedInNominee(h)
    expect((await submitSetup(h.deps, selfConfirmForm(groupId), h.defer)).status).toBe(200)
    h.setNow(after(50_000))
    await h.runDeferred()
    expect(h.store.tables.drive_connections).toHaveLength(0)

    await tick(h, after(15 * MIN), [driveSetupJob])
    expect(h.store.tables.drive_connections).toEqual([expect.objectContaining({ projectId: projectOf(h, groupId), status: 'active' })])
    expect(groupFolderId(h, groupId)).not.toBeNull()
    expect(h.google.shares).toHaveLength(1)
  })

  it('leaves a finished Project alone: its active connection marks it done', async () => {
    const h = setup()
    await seedProject(h)
    await signIn(h)
    h.google.callLog = []
    await tick(h, after(15 * MIN), [driveSetupJob])
    expect(h.google.callLog).toEqual([])
  })

  it('waits 2 minutes after the latest confirm or sign-in, so it never races that request\'s own after() work', async () => {
    const h = setup()
    await signIn(h) // an hour before the confirm, with no Project yet: no Drive work
    const confirmedAt = after(60 * MIN)
    const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await h.store.confirmGroupOwner(g.id, OWNER, confirmedAt)).outcome).toBe('confirmed')
    h.google.callLog = []

    // The sign-in is an hour old, but the confirm's own after() work may still be running.
    await tick(h, new Date(confirmedAt.getTime() + 30_000), [driveSetupJob])
    expect(h.google.callLog).toEqual([])

    await tick(h, new Date(confirmedAt.getTime() + FINISH_AFTER_MS), [driveSetupJob])
    expect(h.store.tables.drive_connections).toHaveLength(1)
  })

  it('stops retrying 2 hours after the latest sign-in or confirm, so a share that keeps failing leaves about 8 more empty folders', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    // A Google Workspace policy that blocks link sharing: each run makes a Project folder it cannot share.
    h.google.shareError = new AdapterError('google drive share 403')
    await signIn(h)
    expect(h.google.foldersNamed('ทีมหลัก')).toHaveLength(1)
    for (let k = 1; k <= 16; k++) await tick(h, after(k * 15 * MIN), [driveSetupJob])
    // One more per tick while the sign-in was 2 minutes to 2 hours old: 15, 30, ... 120 minutes.
    expect(FINISH_WITHIN_MS / (15 * MIN)).toBe(8)
    expect(h.google.foldersNamed('ทีมหลัก')).toHaveLength(1 + 8)
    expect(h.google.callLog.filter((c) => c.at > after(FINISH_WITHIN_MS).getTime())).toEqual([])
    expect(projectRow(h, projectId).driveProjectFolderId ?? null).toBeNull()
    expect(h.store.tables.drive_connections).toHaveLength(0)
  })

  it('leaves alone a Project whose Owner has no Google account, or whose latest one is revoked', async () => {
    const h = setup()
    await seedProject(h) // confirmed at TEST_NOW; the Owner never signed in to Google
    await tick(h, after(15 * MIN), [driveSetupJob])
    expect(h.google.callLog).toEqual([])

    await h.store.upsertGoogleAccount({
      lineUserId: OWNER, googleSubject: 'g-sub-1', email: null,
      grantedScopes: ['https://www.googleapis.com/auth/drive.file'], refreshTokenCiphertext: seal('rt-1', TEST_KEY),
    })
    h.store.tables.google_accounts[0].tokenStatus = 'revoked'
    await tick(h, after(30 * MIN), [driveSetupJob])
    expect(h.google.callLog).toEqual([])
  })

  it('is timed from the start of the tick, so the jobs before it use up its time', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    h.google.driveError = new AdapterError('google drive create 500')
    await signIn(h) // Drive was down: the Project is not connected
    h.google.driveError = null
    h.google.callLog = []
    const slow: TickJob = { name: 'slow', run: async () => h.setNow(new Date(h.deps.now().getTime() + 50_000)) }
    await tick(h, after(15 * MIN), [slow, driveSetupJob])
    expect(h.google.callLog).toEqual([])
    expect(infoEvents()).toContainEqual({ event: 'drive_sync_incomplete', projectId, projectsLeft: 1 })
  })
})
