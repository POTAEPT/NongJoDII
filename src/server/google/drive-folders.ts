import { open } from '../crypto/secretbox'
import { AdapterError, log, logError } from '../log'
import type { Deps, DriveContext, DriveGroup } from '../ports'

// #13: the Owner's Drive layout, by ID only:
//   NongJoDII/                      google_accounts.drive_root_folder_id (one per account)
//     <main group LINE name>/       projects.drive_project_folder_id, shared once
//       Main group files/           groups.drive_folder_id of the main group
//       <Sub group LINE name>/      groups.drive_folder_id of each Sub group
// Every run is idempotent: a stored folder Drive still has is kept; a missing, trashed
// or never-made one is created under its parent and its ID stored. Names are only
// written to Drive, never read back. No code here deletes or moves anything in Drive.

export const ROOT_FOLDER = 'NongJoDII'
export const MAIN_GROUP_FOLDER = 'Main group files'
/** Folder names when neither the store nor LINE has the group's name. */
const PROJECT_FALLBACK = 'Project'
const SUB_GROUP_FALLBACK = 'Sub group'

// Time. Every route that runs this work (google/callback, setup/confirm-owner,
// setup/submit and the tick) has maxDuration 60 s, and the limit covers the handler and
// its after() work alike. So the work is timed from the start of the request (or tick),
// and a step starts only if it still ends in time when every call in it runs to its
// timeout. A step that cannot start stops the whole run (DriveTimeUp), logged as
// drive_sync_incomplete; a later run does the rest.

/** The routes' maxDuration. */
const ROUTE_LIMIT_MS = 60_000
/** Drive work plans to end by this long after its request (or tick) started: the route
 *  limit less 5 s for the last store writes and the log line. */
export const DRIVE_HARD_STOP_MS = ROUTE_LIMIT_MS - 5_000
/** The Google and LINE adapters cut each call at 10 s (google/client.ts, line/client.ts). */
export const DRIVE_CALL_MAX_MS = 10_000
/** A step's own store reads and writes, on top of its calls. */
const STEP_STORE_MS = 1_000

/** The hard stop of Drive work whose request (or tick) started at `startedAt`. */
export function driveDeadline(startedAt: Date): Date {
  return new Date(startedAt.getTime() + DRIVE_HARD_STOP_MS)
}

/** The run stopped before a step it had no time for. Nothing of that step ran. */
export class DriveTimeUp extends Error {
  name = 'DriveTimeUp'
}

/** Throws DriveTimeUp unless a step of `calls` Google or LINE calls, each running to its
 *  timeout, plus the step's store work, still ends by `deadline`. Checked before the
 *  step's first call, so a step never stops halfway: a Project folder is never made
 *  without being shared and stored. */
function checkTime(deps: Deps, deadline: Date, calls: number): void {
  const left = deadline.getTime() - deps.now().getTime()
  if (left < calls * DRIVE_CALL_MAX_MS + STEP_STORE_MS) throw new DriveTimeUp()
}

type Folder = { id: string; recreated: boolean }

/** Deferred after Google sign-in (and after an Owner confirm): lays out the folders of
 *  every Project this person owns as its confirmed Owner, by `deadline` (driveDeadline of
 *  the request's start). Never throws; logs instead. */
export async function syncDriveForOwner(deps: Deps, lineUserId: string, deadline: Date): Promise<void> {
  let projectIds: string[]
  try {
    const account = await deps.store.findGoogleAccountByLineUser(lineUserId)
    if (!account || account.tokenStatus !== 'valid') return
    projectIds = await deps.store.listConfirmedOwnerProjects(lineUserId)
  } catch (err) {
    logError('drive_sync_failed', {}, err)
    return
  }
  await layOutProjects(deps, projectIds, deadline)
}

/** Each Project in turn. A Drive or store failure is logged and the next Project goes on.
 *  Running out of time stops them all, with one log line. */
async function layOutProjects(deps: Deps, projectIds: string[], deadline: Date): Promise<void> {
  for (const [i, projectId] of projectIds.entries()) {
    try {
      await ensureDriveFolders(deps, projectId, deadline)
    } catch (err) {
      if (err instanceof DriveTimeUp) {
        // IDs and counts only. projectsLeft counts this Project too.
        log('drive_sync_incomplete', { projectId, projectsLeft: projectIds.length - i })
        return
      }
      logError('drive_folders_failed', { projectId }, err)
    }
  }
}

/** Root, Project, main group and every Sub group folder of one Project, then its active
 *  Drive connection, by `deadline`. Throws on a Drive or store failure (the caller logs
 *  it) and DriveTimeUp when time runs out; a later run picks up where this one stopped. */
export async function ensureDriveFolders(deps: Deps, projectId: string, deadline: Date): Promise<void> {
  const ctx = await deps.store.getDriveContext(projectId)
  if (!ctx) return
  const run = await openRun(deps, ctx, deadline)
  if (!run) return
  const project = await run.project()
  const groups = [ctx.mainGroup, ...ctx.subGroups].filter((g): g is DriveGroup => g !== null)
  for (const g of groups) await run.group(g, project)
  await run.connect()
}

/** The folder of one group (a Sub group just attached, or before a file is saved),
 *  making the root and Project folders first when needed, by `deadline`. null when the
 *  group has no Project or no confirmed Owner, the Owner has no usable Google account, or
 *  the Project's active connection is another Google account. Throws on a token, Drive or
 *  store failure, and DriveTimeUp when time runs out, so the caller (the Sub group attach
 *  flow, #4's file save) must catch. */
export async function ensureGroupFolder(deps: Deps, groupId: string, deadline: Date): Promise<string | null> {
  const row = await deps.store.getGroupById(groupId)
  if (!row?.projectId) return null
  const ctx = await deps.store.getDriveContext(row.projectId)
  if (!ctx) return null
  const target = [ctx.mainGroup, ...ctx.subGroups].find((g) => g?.groupId === groupId)
  if (!target) return null
  const run = await openRun(deps, ctx, deadline)
  if (!run) return null
  const folderId = await run.group(target, await run.project())
  await run.connect()
  return folderId
}

/** null (logged) when the Project's Drive cannot be used: no valid account, or the
 *  active connection belongs to another Google account (changing accounts is #3's flow). */
async function openRun(deps: Deps, ctx: DriveContext, deadline: Date) {
  const { projectId } = ctx
  const account = ctx.account
  if (!account || account.tokenStatus !== 'valid' || account.refreshTokenCiphertext === null) {
    log('drive_folders_skipped', { projectId, reason: 'no_account' })
    return null
  }
  if (ctx.activeAccountId !== null && ctx.activeAccountId !== account.id) {
    log('drive_folders_skipped', { projectId, reason: 'other_account' })
    return null
  }
  const refreshToken = open(account.refreshTokenCiphertext, deps.config.tokenEncryptionKey)
  if (refreshToken === null) throw new AdapterError('drive refresh token unreadable')
  checkTime(deps, deadline, 1)
  const token = await deps.google.accessToken(refreshToken)
  const google = deps.google
  const accountId = account.id
  const storedRootId = account.rootFolderId
  let created = 0

  /** Keeps `stored` while Drive still has it; otherwise makes one and stores it. A
   *  recreated parent means its children went with it, so they are made anew. One step:
   *  `makeCalls` is how many Google or LINE calls `make` may need. */
  async function ensure(
    stored: string | null, parent: Folder | null, makeCalls: number, make: () => Promise<string>,
    save: (from: string | null, to: string) => Promise<{ folderId: string | null }>,
  ): Promise<Folder> {
    const verify = stored !== null && !parent?.recreated
    checkTime(deps, deadline, (verify ? 1 : 0) + makeCalls)
    if (verify && (await google.getFolder(token, stored)) === 'ok') {
      return { id: stored, recreated: false }
    }
    const id = await make()
    created++
    const { folderId } = await save(stored, id)
    if (folderId === null) throw new AdapterError('drive folder owner row vanished')
    // Another run stored its folder first: use that one (ours stays, empty, in Drive).
    return { id: folderId, recreated: folderId === id }
  }

  let root: Folder | null = null
  async function rootFolder(): Promise<Folder> {
    root ??= await ensure(
      storedRootId, null, 1,
      () => google.createFolder(token, ROOT_FOLDER, null),
      (from, to) => deps.store.setDriveRootFolder(accountId, from, to),
    )
    return root
  }

  let project: Folder | null = null
  return {
    async project(): Promise<Folder> {
      const parent = await rootFolder()
      // The name lookup (when no name is stored), the create and the share.
      const lookup = ctx.mainGroup !== null && !ctx.mainGroup.name ? 1 : 0
      project ??= await ensure(
        ctx.projectFolderId, parent, lookup + 2,
        async () => {
          const name = ctx.mainGroup ? await groupName(deps, ctx.mainGroup, PROJECT_FALLBACK) : PROJECT_FALLBACK
          const id = await google.createFolder(token, name, parent.id)
          // Shared before its ID is stored: a stored Project folder is always shared.
          // Files inside inherit it; nothing is ever shared one by one.
          await google.shareAnyoneReader(token, id)
          return id
        },
        (from, to) => deps.store.setProjectDriveFolder(projectId, from, to),
      )
      return project
    },
    async group(g: DriveGroup, parent: Folder): Promise<string> {
      const isMain = g.groupId === ctx.mainGroup?.groupId
      // The name lookup (a Sub group with no stored name) and the create.
      const lookup = !isMain && !g.name ? 1 : 0
      const folder = await ensure(
        g.folderId, parent, lookup + 1,
        async () => {
          const name = isMain ? MAIN_GROUP_FOLDER : await groupName(deps, g, SUB_GROUP_FALLBACK)
          return google.createFolder(token, name, parent.id)
        },
        (from, to) => deps.store.setGroupDriveFolder(g.groupId, from, to),
      )
      return folder.id
    },
    async connect(): Promise<void> {
      checkTime(deps, deadline, 0)
      const { created: connected } = await deps.store.ensureDriveConnection(projectId, accountId)
      log('drive_folders', { projectId, created, connected })
    },
  }
}

/** The group's stored LINE name; else LINE's group summary (stored for next time);
 *  else `fallback`. Only the folder is named by it. */
async function groupName(deps: Deps, g: DriveGroup, fallback: string): Promise<string> {
  if (g.name) return g.name
  try {
    const summary = await deps.line.getGroupSummary(g.lineGroupId)
    if (summary?.groupName) {
      g.name = summary.groupName
      await deps.store.setGroupName(g.groupId, summary.groupName)
      return summary.groupName
    }
  } catch (err) {
    logError('group_name_failed', { groupId: g.groupId }, err)
  }
  return fallback
}
