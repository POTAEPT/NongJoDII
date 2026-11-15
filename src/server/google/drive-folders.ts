import { open } from '../crypto/secretbox'
import { AdapterError, GoogleTokenRevoked, log, logError } from '../log'
import type { Deps, DriveContext, DriveGroup } from '../ports'
import type { TickJob } from '../tick/run-tick'
import { LOST_ACCESS_CALLS, markAccessLost } from './lost-access'

// #13: the Owner's Drive layout, by ID only:
//   NongJoDII/                      google_accounts.drive_root_folder_id (one per account)
//     <main group LINE name>/       projects.drive_project_folder_id, shared once
//       Main group files/           groups.drive_folder_id of the main group
//       <Sub group LINE name>/      groups.drive_folder_id of each Sub group
// Every run is idempotent: a stored folder Drive still has is kept; a missing, trashed
// or never-made one is created under its parent and its ID stored. Names are only
// written to Drive, never read back. No code here deletes or moves anything in Drive.
// One Google account per Project: before its first Project or group folder ID write (or
// at the end, when it writes none), a run claims the Project's active drive_connections
// row (claimDriveConnection). A run whose account does not hold that row stops and writes
// nothing more. Root folder IDs are per account and need no claim.

export const ROOT_FOLDER = 'NongJoDII'
export const MAIN_GROUP_FOLDER = 'Main group files'
/** Folder names when neither the store nor LINE has the group's name. */
const PROJECT_FALLBACK = 'Project'
const SUB_GROUP_FALLBACK = 'Sub group'

// Time. Every route that runs this work (google/callback, setup/confirm-owner,
// setup/submit and the tick) has maxDuration 60 s, and the limit covers the handler and
// its after() work alike. So the work is timed from the start of the request (or tick),
// and a step starts only if it still ends in time when every call in it runs to its
// timeout. The steps: the token refresh, each verify (getFolder), each LINE name lookup,
// and each make. Only a make is atomic: create, share and store for a Project folder;
// create and store for a group or root folder. A step that cannot start stops the whole
// run (DriveTimeUp), logged as drive_sync_incomplete; the tick finisher (driveSetupJob)
// or the Owner's next sign-in does the rest.

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

/** Another Google account holds the Project's active connection row: this run stops. */
class DriveClaimLost extends Error {
  name = 'DriveClaimLost'
}

/** A run that lost the claim: logged like the other_account pre-check, not as a failure. */
function lostClaim(projectId: string): null {
  log('drive_folders_skipped', { projectId, reason: 'other_account' })
  return null
}

/** Throws DriveTimeUp unless a step of `calls` Google or LINE calls, each running to its
 *  timeout, plus the step's store work, still ends by `deadline`. Checked before the
 *  step's first call, so a step never stops halfway: a Project folder is never made
 *  without being shared and stored. */
export function checkTime(deps: Deps, deadline: Date, calls: number): void {
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
  await layOutProjects(deps, projectIds, deadline, 'request')
}

/** The tick finisher leaves a Project alone for this long after its Owner confirm or
 *  Google sign-in, so it never races that request's own after() run (60 s at most), where
 *  the loser would leave an empty folder behind. */
export const FINISH_AFTER_MS = 2 * 60_000
/** ...and stops retrying this long after it. A share that keeps failing (for example, a
 *  Google Workspace policy that blocks link sharing) leaves one empty Project folder per
 *  run, so a 15-minute tick leaves about 8. A new sign-in or confirm starts the window
 *  again, and so does a run that stores a new root folder (that write moves updated_at). */
export const FINISH_WITHIN_MS = 2 * 3600_000

/** Tick job (#13): finishes the Drive setups that a request ran out of time for, or that
 *  failed, while the latest confirm or sign-in is 2 minutes to 2 hours old. Timed from
 *  the tick's start like a request, and last in the tick, after the jobs that push. */
export const driveSetupJob: TickJob = {
  name: 'drive_setup',
  async run(deps, now) {
    const projectIds = await deps.store.listUnfinishedDriveProjects(
      new Date(now.getTime() - FINISH_WITHIN_MS), new Date(now.getTime() - FINISH_AFTER_MS),
    )
    await layOutProjects(deps, projectIds, driveDeadline(now), 'finish')
  },
}

/** How a run treats the folders it finds stored. 'request' (sign-in, Owner confirm,
 *  ensureGroupFolder) verifies each one it relies on. 'finish' (the tick finisher) verifies
 *  only the Project folder, the parent of what it makes, and trusts stored group folder
 *  IDs, so a retry spends its time on the folders still missing. */
type RunMode = 'request' | 'finish'

/** Each Project in turn. A Drive or store failure is logged and the next Project goes on.
 *  Running out of time stops them all, with one log line. */
async function layOutProjects(deps: Deps, projectIds: string[], deadline: Date, mode: RunMode): Promise<void> {
  for (const [i, projectId] of projectIds.entries()) {
    try {
      await layOutProject(deps, projectId, deadline, mode)
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

/** Root, Project, main group and every Sub group folder of one Project, by `deadline`,
 *  under the claim of one Google account. Throws on a Drive or store failure (the caller
 *  logs it) and DriveTimeUp when time runs out; a later run picks up where this one
 *  stopped. A run that loses the claim to another account logs it and returns. */
export async function ensureDriveFolders(deps: Deps, projectId: string, deadline: Date): Promise<void> {
  await layOutProject(deps, projectId, deadline, 'request')
}

async function layOutProject(deps: Deps, projectId: string, deadline: Date, mode: RunMode): Promise<void> {
  const ctx = await deps.store.getDriveContext(projectId)
  if (!ctx) return
  const run = await openRun(deps, ctx, deadline, mode)
  if (!run) return
  try {
    const project = await run.project()
    const groups = [ctx.mainGroup, ...ctx.subGroups].filter((g): g is DriveGroup => g !== null)
    // Missing folders first: a run short of time makes them before it verifies stored ones.
    for (const g of [...groups.filter((x) => x.folderId === null), ...groups.filter((x) => x.folderId !== null)]) {
      await run.group(g, project)
    }
    await run.finish()
  } catch (err) {
    if (err instanceof DriveClaimLost) return void lostClaim(projectId)
    throw err
  }
}

/** The folder of one group (a Sub group just attached, or before a file is saved),
 *  making the root and Project folders first when needed, by `deadline`. null when the
 *  group has no Project or no confirmed Owner, the Owner has no usable Google account, or
 *  another Google account holds the Project. Throws on a token, Drive or store failure,
 *  and DriveTimeUp when time runs out, so the caller (the Sub group attach flow, #4's file
 *  save) must catch. */
export async function ensureGroupFolder(deps: Deps, groupId: string, deadline: Date): Promise<string | null> {
  const row = await deps.store.getGroupById(groupId)
  if (!row?.projectId) return null
  const ctx = await deps.store.getDriveContext(row.projectId)
  if (!ctx) return null
  const target = [ctx.mainGroup, ...ctx.subGroups].find((g) => g?.groupId === groupId)
  if (!target) return null
  const run = await openRun(deps, ctx, deadline, 'request')
  if (!run) return null
  try {
    const folderId = await run.group(target, await run.project())
    await run.finish()
    return folderId
  } catch (err) {
    if (err instanceof DriveClaimLost) return lostClaim(ctx.projectId)
    throw err
  }
}

/** null (logged) when the Project's Drive cannot be used: no valid account, the active
 *  connection belongs to another Google account (a sign-in with a new account retires it,
 *  see callback.ts), or Google refused the refresh token (#14: the account is marked
 *  revoked and the main group is asked once to sign in again). The account check is only
 *  a cheap first look: the claim decides. */
async function openRun(deps: Deps, ctx: DriveContext, deadline: Date, mode: RunMode) {
  const { projectId } = ctx
  const account = ctx.account
  if (!account || account.tokenStatus !== 'valid' || account.refreshTokenCiphertext === null) {
    log('drive_folders_skipped', { projectId, reason: 'no_account' })
    return null
  }
  if (ctx.activeAccountId !== null && ctx.activeAccountId !== account.id) return lostClaim(projectId)
  const refreshToken = open(account.refreshTokenCiphertext, deps.config.tokenEncryptionKey)
  if (refreshToken === null) throw new AdapterError('drive refresh token unreadable')
  checkTime(deps, deadline, 1)
  let token: string
  try {
    token = await deps.google.accessToken(refreshToken)
  } catch (err) {
    if (!(err instanceof GoogleTokenRevoked)) throw err
    // Marking the account and posting the card are one step: with no time for the card,
    // the account stays valid and a later run meets the revocation again.
    checkTime(deps, deadline, LOST_ACCESS_CALLS)
    await markAccessLost(deps, ctx, { id: account.id, refreshTokenCiphertext: account.refreshTokenCiphertext })
    return null
  }
  const google = deps.google
  const accountId = account.id
  const storedRootId = account.rootFolderId
  let created = 0

  // The claim: the Project's active drive_connections row, read once per run. It is taken
  // after the Project folder is shared, so an account that cannot share never takes it.
  let claim: { created: boolean; accountId: string } | null = null
  async function claimProject(): Promise<{ created: boolean }> {
    claim ??= await deps.store.claimDriveConnection(projectId, accountId)
    if (claim.accountId !== accountId) throw new DriveClaimLost()
    return claim
  }

  /** A verify step, one call: Drive still has the stored folder. */
  async function stillThere(folderId: string): Promise<boolean> {
    checkTime(deps, deadline, 1)
    return (await google.getFolder(token, folderId)) === 'ok'
  }

  /** A name step, one call, only when no name is stored: LINE's group summary. Its own
   *  step, checked here rather than in groupName, whose catch would turn DriveTimeUp into
   *  the fallback name. The name it finds is stored, so a later run skips it. */
  async function nameOf(g: DriveGroup, fallback: string): Promise<string> {
    if (!g.name) checkTime(deps, deadline, 1)
    return groupName(deps, g, fallback)
  }

  /** A make step, the only atomic one: `calls` calls in `make` (create, and share for a
   *  Project folder), then, for a Project or group folder (`claimed`), the claim, then the
   *  compare-and-set write of the new ID over `stored`. */
  async function makeAndStore(
    stored: string | null, calls: number, claimed: boolean, make: () => Promise<string>,
    save: (from: string | null, to: string) => Promise<{ folderId: string | null }>,
  ): Promise<Folder> {
    checkTime(deps, deadline, calls)
    const id = await make()
    created++
    if (claimed) await claimProject()
    const { folderId } = await save(stored, id)
    if (folderId === null) throw new AdapterError('drive folder owner row vanished')
    // Another run of this same account stored its folder first: use that one (ours
    // stays, empty, in Drive). A run of another account never gets here: it lost the claim.
    return { id: folderId, recreated: folderId === id }
  }

  let root: Folder | null = null
  async function rootFolder(): Promise<Folder> {
    if (root) return root
    if (storedRootId !== null && (await stillThere(storedRootId))) return (root = { id: storedRootId, recreated: false })
    root = await makeAndStore(
      storedRootId, 1, false,
      () => google.createFolder(token, ROOT_FOLDER, null),
      (from, to) => deps.store.setDriveRootFolder(accountId, from, to),
    )
    return root
  }

  let project: Folder | null = null
  return {
    /** Both modes verify a stored Project folder: it is the parent of every folder a run
     *  makes. The root is checked only when a Project folder must be made under it; a
     *  folder inside a trashed or deleted root reads as trashed or missing itself. */
    async project(): Promise<Folder> {
      if (project) return project
      const stored = ctx.projectFolderId
      if (stored !== null && (await stillThere(stored))) return (project = { id: stored, recreated: false })
      const parent = await rootFolder()
      const name = ctx.mainGroup ? await nameOf(ctx.mainGroup, PROJECT_FALLBACK) : PROJECT_FALLBACK
      project = await makeAndStore(
        stored, 2, true,
        async () => {
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
    /** A stored group folder is verified on a request; the finisher trusts it (a sign-in
     *  or ensureGroupFolder verifies it later). */
    async group(g: DriveGroup, parent: Folder): Promise<string> {
      const stored = g.folderId
      if (stored !== null && !parent.recreated && (mode === 'finish' || (await stillThere(stored)))) return stored
      const isMain = g.groupId === ctx.mainGroup?.groupId
      const name = isMain ? MAIN_GROUP_FOLDER : await nameOf(g, SUB_GROUP_FALLBACK)
      const folder = await makeAndStore(
        stored, 1, true,
        () => google.createFolder(token, name, parent.id),
        (from, to) => deps.store.setGroupDriveFolder(g.groupId, from, to),
      )
      return folder.id
    },
    /** The end of a run: a run that stored no folder ID claims the Project here. */
    async finish(): Promise<void> {
      if (claim === null) checkTime(deps, deadline, 0)
      const { created: connected } = await claimProject()
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
