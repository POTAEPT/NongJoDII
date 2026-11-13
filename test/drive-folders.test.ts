import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { finishGoogleSignIn } from '@/server/google/callback'
import { ensureDriveFolders, ensureGroupFolder, MAIN_GROUP_FOLDER, ROOT_FOLDER } from '@/server/google/drive-folders'
import { startGoogleSignIn } from '@/server/google/start'
import { AdapterError } from '@/server/log'
import { confirmOwner } from '@/server/setup/confirm'
import { makeTestDeps, TEST_NOW } from './harness'

// #13 acceptance: after Google sign-in (and an Owner confirm), the Owner's Drive gets
// NongJoDII/<main group>/Main group files and one folder per Sub group, IDs stored,
// the Project folder shared once, and one active Drive connection.

const OWNER = 'Uowner1'
const OWNER_TOKEN = 'idtok-owner'
const MAIN_LINE_GROUP = 'Cmain'

let errors: MockInstance<typeof console.error>
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function errorEvents(): Record<string, unknown>[] {
  return errors.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}

type H = ReturnType<typeof makeTestDeps>

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

/** Google sign-in from start to callback, then the deferred Drive work. */
async function signIn(h: H) {
  const res = await startGoogleSignIn(h.deps, { idToken: OWNER_TOKEN })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  const outcome = await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'code-1', state }), h.defer)
  await h.runDeferred()
  return outcome
}

const account = (h: H) => h.store.tables.google_accounts[0]
const projectRow = (h: H, id: string) => h.store.tables.projects.find((p) => p.id === id)!
const groupFolderId = (h: H, groupId: string) => h.store.tables.group_setups.find((r) => r.groupId === groupId)?.driveFolderId ?? null

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
    const id = await ensureGroupFolder(h.deps, sub)
    expect(id).toBe(groupFolderId(h, sub))
    expect(h.google.folders.get(id as string)).toMatchObject({
      name: 'ทีมย่อย', parentId: projectRow(h, projectId).driveProjectFolderId,
    })
    expect(h.google.folders.size).toBe(before + 1)
    expect(h.google.shares).toHaveLength(1)
    // Again: the stored folder is kept.
    expect(await ensureGroupFolder(h.deps, sub)).toBe(id)
    expect(h.google.folders.size).toBe(before + 1)
  })

  it('builds the root and Project folders first when they are not there yet', async () => {
    const h = setup()
    const { projectId } = await seedProject(h)
    await signIn(h)
    h.google.trash(account(h).driveRootFolderId as string)
    const sub = seedSubGroup(h, projectId, { lineGroupId: 'Csub1', name: 'ทีมย่อย' })
    const id = await ensureGroupFolder(h.deps, sub)
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
    expect(await ensureGroupFolder(h.deps, loose.id)).toBeNull()
    expect(await ensureGroupFolder(h.deps, pending)).toBeNull()
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
    await Promise.all([ensureDriveFolders(h.deps, projectId), ensureDriveFolders(h.deps, projectId)])
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
})
