import { createHash } from 'node:crypto'
import { DRIVE_HARD_STOP_MS, DriveTimeUp, openGroupDrive } from '../google/drive-folders'
import { shareRefusedKey } from '../google/share-refused'
import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { AdapterError, ContentTooLarge, log, logError } from '../log'
import { ownerBackedOn } from '../members/owner-left'
import type { Deps, SavedFile } from '../ports'
import { bangkokParts } from '../time/bangkok'
import type { Job } from '../webhook/ingest'
import { driveFolderLink, fileFailedCard, fileSavedCard, photosFailedCard, photosSavedCard } from './card'

// #4 Feature 1, file saver. A file or image sent in a group of a Project is downloaded from
// LINE at once (the webhook carries only its ID), hashed, and uploaded to that group's Drive
// folder (main group: "Main group files"; Sub group: its own folder, #13) through the Project's
// active Drive connection. Then the bot posts a "saved" card with the link.
//
// Time. The job runs inside the webhook's after() (route maxDuration 60 s), timed from the
// moment the request came in (`receivedAt`). The download, the Drive steps and the upload
// get only the time left until DRIVE_HARD_STOP_MS (55 s) less POST_SAVE_RESERVE_MS, so the
// files row and the card (or the "couldn't save" card) still go out in time. The card
// is a reply (free) when it goes out within REPLY_WINDOW_MS of the webhook, since LINE's
// reply token lasts one minute; after that it is a push, counted by the push budget (#25)
// and skipped near the monthly quota, where the file shows on the Dashboard only.
//
// Duplicates (files_one_per_hash): content already saved in the group is not uploaded
// again. Its files row is pointed at the new message (message_id), so the newest message
// that carried the file answers a quote-reply "NongJoDII ขอไฟล์" (#33), and the card shows
// the stored link. The earlier message stops resolving; its own card still has the link.
//
// Photo batches (LINE imageSet): one webhook per photo, in any order, possibly in separate
// requests. Each job, once its own photo is settled (saved, or failed for good), counts the
// batch in the database: with imageSet.total, the batch is complete when that many photos are
// settled; without it (LINE 11.15 or earlier on Android) every stored photo of the set must
// be settled and no new one may arrive within BATCH_QUIET_MS. A complete batch is claimed in
// image_set_cards, so exactly one job posts the one "saved N photos" card.
//
// Failures (download, Drive call, upload, time, content gone, too large, a store error):
// no retry. The group gets one "couldn't save" card per message, or the batch card counts
// the photo.
//
// Pauses (no card, nothing settled): the group has no confirmed Owner (owner_confirmed_at is
// cleared when the Owner leaves, #30), the setup form turned file saving off, or no Drive can
// be used (no valid Google account, or Drive access was lost: the #14 path marks the account
// and asks the Owner once to sign in again). No files row is written; the message row stays.

export const SAVE_HARD_STOP_MS = DRIVE_HARD_STOP_MS
/** The LINE client cuts each call at 10 s; a store step is given about 1 s. */
const LINE_CALL_MS = 10_000
const STORE_STEP_MS = 1_000
/** Worst case of a reply: one LINE call. */
export const REPLY_WORST_MS = LINE_CALL_MS + STORE_STEP_MS
/** Worst case of a push through the budget (line/push-budget.ts): the quota and member
 *  count reads run together (one LINE call long), the budget claim, the push, and a release. */
export const PUSH_WORST_MS = 2 * LINE_CALL_MS + 2 * STORE_STEP_MS
/** Kept back from the download, the Drive steps and the upload, for what must still run
 *  after them: the files row (insert and link), the settled row, the batch count and claim,
 *  and the card sent as a push in the worst case. */
export const POST_SAVE_RESERVE_MS = PUSH_WORST_MS + 5 * STORE_STEP_MS
/** The card is a reply only this soon after the webhook. LINE's reply token lasts one minute;
 *  this window sits inside the time a save may take (the hard stop less the reserve), so a
 *  save that runs late gets its card as a push, counted by the push budget. */
export const REPLY_WINDOW_MS = 25_000
/** Files above this are not saved: the whole file is held in memory to hash and upload it. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
/** A batch without imageSet.total: a photo of the set that arrives within this long of the
 *  last one keeps the batch open. */
export const BATCH_QUIET_MS = 10_000
/** Share of the monthly quota a saved or failed card leaves unspent: as the Tasks-created post. */
export const FILE_SAVED_PUSH_RESERVE = 0.1
/** A step needs at least this much time left to start. */
const MIN_STEP_MS = 1_000

type FileJob = Extract<Job, { kind: 'group_file' }>

export type FileSaveOutcome =
  | 'saved' | 'duplicate' | 'paused' | 'too_large' | 'gone' | 'no_drive' | 'failed' | 'timeout'

/** A failed save, as the "couldn't save" card and the logs name it. */
type FailReason = Exclude<FileSaveOutcome, 'saved' | 'duplicate' | 'paused'>

/** The settled-message ledger row: one per message, `file:<LINE message ID>`, in
 *  webhook_events (insert on conflict do nothing), so no column is needed. Its event type
 *  says whether the message was saved or failed for good. A batch counts these rows. */
export function fileOutcomeKey(lineMessageId: string): string {
  return `file:${lineMessageId}`
}
export const FILE_SAVED_EVENT = 'file_saved'
export const FILE_FAILED_EVENT = 'file_save_failed'

export async function handleGroupFile(deps: Deps, job: FileJob): Promise<FileSaveOutcome> {
  const ids = { groupId: job.groupId, messageType: job.messageType }
  // The Drive file ID once the upload succeeded, so a later failure can name it.
  const progress: { driveFileId: string | null } = { driveFileId: null }
  let saved: Saved | FileSaveOutcome
  try {
    saved = await save(deps, job, progress)
  } catch (err) {
    // A store error (or any other throw) is a failure like the others: it settles the
    // message and sends the card, so a batch never waits on it. An uploaded copy is named
    // in the log (IDs only) so it can be found in the Owner's Drive.
    if (progress.driveFileId !== null) log('file_save_orphan', { ...ids, driveFileId: progress.driveFileId })
    return failed(deps, job, 'failed', err)
  }
  if (typeof saved === 'string') return saved
  const { file, duplicate, linkShared } = saved
  log('file_saved', { ...ids, duplicate, sizeBytes: file.sizeBytes, linkShared })
  try {
    const settledAs = await settle(deps, job, FILE_SAVED_EVENT)
    if (job.imageSet) {
      await announceBatch(deps, job)
    } else if (settledAs !== 'repeat') {
      // A second run of the same message (its row was there) sent its card already.
      const card = fileSavedCard({
        kind: job.messageType, fileName: file.fileName, sizeBytes: file.sizeBytes, driveLink: file.driveLink, duplicate, linkShared,
      })
      await sendCard(deps, job, card, `file_saved:${job.storedMessageId}`)
    }
  } catch (err) {
    logError('file_card_failed', ids, err)
  }
  return duplicate ? 'duplicate' : 'saved'
}

type Saved = { file: SavedFile; duplicate: boolean; linkShared: boolean | null }

/** The save itself, up to the files row. Answers a FileSaveOutcome when it stopped (a pause,
 *  or a failure it already reported). Throws on a store error. */
async function save(deps: Deps, job: FileJob, progress: { driveFileId: string | null }): Promise<Saved | FileSaveOutcome> {
  const deadline = job.receivedAt.getTime() + SAVE_HARD_STOP_MS
  // Time for the slow steps: the reserve stays for the rows, the claim and the card.
  const workLeft = () => deadline - POST_SAVE_RESERVE_MS - deps.now().getTime()
  const ids = { groupId: job.groupId, messageType: job.messageType }

  const group = await deps.store.getGroupById(job.groupId)
  // Paused while the Owner left (#30) or a Sub group waits for the take-over answer (#31):
  // both clear owner_confirmed_at. A paused save is not a failure: no card.
  if (!group?.projectId || !ownerBackedOn(group)) return skipped(ids, 'no_owner')
  const setup = await deps.store.getGroupSetup(job.groupId)
  if (!setup?.features.saveFiles) return skipped(ids, 'feature_off')
  const fail = (reason: FailReason, err?: unknown) => failed(deps, job, reason, err)
  if (job.fileSize !== null && job.fileSize > MAX_FILE_BYTES) return fail('too_large')

  if (workLeft() < MIN_STEP_MS) return fail('timeout')
  let content: { data: Uint8Array; contentType: string | null } | null
  try {
    content = await deps.line.getMessageContent(job.lineMessageId, { timeoutMs: workLeft(), maxBytes: MAX_FILE_BYTES })
  } catch (err) {
    if (err instanceof ContentTooLarge) return fail('too_large')
    return fail(isTimeout(err) ? 'timeout' : 'failed', err)
  }
  if (!content) return fail('gone')
  const sha256 = createHash('sha256').update(content.data).digest('hex')

  const existing = await deps.store.findFileByHash(job.groupId, sha256)
  if (existing) {
    // Saved before: no Google call, so a duplicate is answered even while Drive access is lost.
    await deps.store.linkFileToMessage(existing.id, job.storedMessageId)
    return { file: existing, duplicate: true, linkShared: null }
  }
  let drive
  try {
    drive = await openGroupDrive(deps, job.groupId, new Date(deadline - POST_SAVE_RESERVE_MS))
  } catch (err) {
    return fail(err instanceof DriveTimeUp ? 'timeout' : 'failed', err)
  }
  // No usable Drive is a pause, not a failure: no account, the token was revoked (the #14
  // card already asks the Owner to sign in again), or another Google account holds the
  // Project. Logged inside.
  if (!drive) return skipped(ids, 'no_drive')
  const connection = await deps.store.findActiveDriveConnection(drive.projectId)
  if (!connection || connection.googleAccountId !== drive.googleAccountId) return skipped(ids, 'other_account')
  if (workLeft() < MIN_STEP_MS) return fail('timeout')
  const mimeType = mimeOf(job, content.contentType)
  const fileName = nameOf(job, mimeType)
  let uploaded: { id: string; webViewLink: string }
  try {
    uploaded = await deps.google.uploadFile(
      drive.accessToken, { name: fileName, parentId: drive.folderId, mimeType, data: content.data }, { timeoutMs: workLeft() },
    )
  } catch (err) {
    return fail(isTimeout(err) ? 'timeout' : 'failed', err)
  }
  progress.driveFileId = uploaded.id
  const result = await deps.store.insertFile({
    groupId: job.groupId, messageId: job.storedMessageId, senderLineUserId: job.senderLineUserId,
    driveConnectionId: connection.id, fileName, contentSha256: sha256, driveFileId: uploaded.id,
    driveLink: uploaded.webViewLink, sentAt: job.sentAt, savedAt: deps.now(), sizeBytes: content.data.byteLength,
  })
  if (!result.inserted) {
    // The same content was saved by another job at the same moment. Ours is a second copy
    // in Drive, left there (no code deletes files in the Owner's Drive).
    log('file_saved_twice', { groupId: job.groupId, driveFileId: uploaded.id })
    await deps.store.linkFileToMessage(result.file.id, job.storedMessageId)
    return { file: result.file, duplicate: true, linkShared: drive.linkShared }
  }
  return { file: result.file, duplicate: false, linkShared: drive.linkShared }
}

function skipped(ids: { groupId: string; messageType: string }, reason: string): FileSaveOutcome {
  log('file_save_skipped', { ...ids, reason })
  return 'paused'
}

function isTimeout(err: unknown): boolean {
  return err instanceof AdapterError && / timeout$/.test(err.message)
}

/** Writes the message's settled row: 'first' this call wrote it, 'repeat' it was there (a
 *  second run of the same message, whose card was already handled), 'error' the store
 *  failed (logged). On an error the card is still sent: a rare double beats a lost card. */
async function settle(deps: Deps, job: FileJob, eventType: string): Promise<'first' | 'repeat' | 'error'> {
  try {
    const { inserted } = await deps.store.recordWebhookEvent({
      webhookEventId: fileOutcomeKey(job.lineMessageId), eventType, lineGroupId: job.lineGroupId,
      eventTimestamp: deps.now(), isRedelivery: false,
    })
    return inserted ? 'first' : 'repeat'
  } catch (err) {
    logError('file_settle_failed', { groupId: job.groupId }, err)
    return 'error'
  }
}

/** A save that failed for good. No retry (decided: option B): the group gets one "couldn't
 *  save" card for the message (the settled row makes it once-only), or, for a photo of a
 *  batch, the batch card counts it. Never throws. */
async function failed(deps: Deps, job: FileJob, reason: FailReason, err?: unknown): Promise<FileSaveOutcome> {
  if (err === undefined) log('file_save_failed', { groupId: job.groupId, messageType: job.messageType, reason })
  else logError('file_save_failed', { groupId: job.groupId, messageType: job.messageType, reason }, err)
  try {
    const settledAs = await settle(deps, job, FILE_FAILED_EVENT)
    if (job.imageSet) {
      await announceBatch(deps, job)
    } else if (settledAs !== 'repeat') {
      const card = fileFailedCard({ kind: job.messageType, fileName: job.fileName, reason })
      await sendCard(deps, job, card, `file_failed:${job.storedMessageId}`)
    }
  } catch (e) {
    logError('file_card_failed', { groupId: job.groupId, messageType: job.messageType }, e)
  }
  return reason
}

/** A photo of a batch (LINE imageSet) settled. The job that finds the whole batch settled
 *  claims it (image_set_cards) and posts the one card: the photos saved, and how many could
 *  not be saved. Settled = saved or failed for good, so one bad photo never blocks the card. */
async function announceBatch(deps: Deps, job: FileJob): Promise<void> {
  const { id: imageSetId, total } = job.imageSet!
  let c = await deps.store.countImageSet(job.groupId, imageSetId)
  const settled = (x: typeof c) => x.saved + x.failed
  if (total !== null) {
    if (settled(c) < total) return // a photo still to come settles last and posts
  } else {
    // No photo is known to be last. All stored photos are settled; wait for more to arrive.
    // A photo that comes within the wait makes this job step back: that photo's job waits
    // in turn, so photos a few seconds apart still make one batch. The wait is cut to the
    // time left before the card's own reserve, never skipped while any is left.
    if (settled(c) < c.messages) return
    const deadline = job.receivedAt.getTime() + SAVE_HARD_STOP_MS
    const wait = Math.min(BATCH_QUIET_MS, deadline - PUSH_WORST_MS - 2 * STORE_STEP_MS - deps.now().getTime())
    if (wait > 0) {
      await (deps.sleep ?? defaultSleep)(wait)
      const again = await deps.store.countImageSet(job.groupId, imageSetId)
      if (again.messages !== c.messages || settled(again) < again.messages) return
      c = again
    }
  }
  const { claimed } = await deps.store.claimImageSetCard(job.groupId, imageSetId)
  if (!claimed) return
  let card: LineMessage
  if (c.saved === 0) {
    card = photosFailedCard({ count: c.failed })
  } else {
    // The folder's own state, not this job's: any photo of the batch may be the last to settle.
    const folder = await groupFolderState(deps, job.groupId)
    card = photosSavedCard({
      count: c.saved, failed: c.failed, link: folder.folderId ? driveFolderLink(folder.folderId) : null,
      isFolder: true, linkShared: folder.linkShared,
    })
  }
  await sendCard(deps, job, card, `photos_saved:${job.groupId}:${imageSetId}`)
}

/** The group's stored Drive folder ID, and whether its Project folder's link share is known
 *  to be refused (the once-only Owner card's ledger row, google/share-refused.ts). No Google
 *  call, so "shared" is never claimed here: refused -> false, else null (the card is silent). */
async function groupFolderState(deps: Deps, groupId: string): Promise<{ folderId: string | null; linkShared: boolean | null }> {
  try {
    const group = await deps.store.getGroupById(groupId)
    if (!group?.projectId) return { folderId: null, linkShared: null }
    const ctx = await deps.store.getDriveContext(group.projectId)
    const folderId = [ctx?.mainGroup, ...(ctx?.subGroups ?? [])].find((g) => g?.groupId === groupId)?.folderId ?? null
    const refused = ctx?.projectFolderId ? await deps.store.hasWebhookEvent(shareRefusedKey(ctx.projectFolderId)) : false
    return { folderId, linkShared: refused ? false : null }
  } catch (err) {
    logError('file_folder_read_failed', { groupId }, err)
    return { folderId: null, linkShared: null }
  }
}

/** Reply while the reply token is surely still valid, else a push inside the push budget.
 *  Each is sent only if its worst case still ends by the hard stop. A reply LINE refused
 *  (a 4xx: the token expired or was used) falls back to a push; a reply that timed out or
 *  got a 5xx may have reached the group, so it is not pushed again. */
async function sendCard(deps: Deps, job: FileJob, card: LineMessage, key: string): Promise<void> {
  const hardStop = job.receivedAt.getTime() + SAVE_HARD_STOP_MS
  const elapsed = () => deps.now().getTime() - job.receivedAt.getTime()
  const left = () => hardStop - deps.now().getTime()
  if (job.replyToken && elapsed() <= REPLY_WINDOW_MS && left() >= REPLY_WORST_MS) {
    try {
      await deps.line.reply(job.replyToken, [card])
      log('file_card', { groupId: job.groupId, via: 'reply' })
      return
    } catch (err) {
      logError('file_card_reply_failed', { groupId: job.groupId }, err)
      if (!(err instanceof AdapterError && /^line reply 4\d\d$/.test(err.message))) return
    }
  }
  if (left() < PUSH_WORST_MS) {
    // No time for a push before the route's limit: the file is on the Dashboard.
    log('file_card', { groupId: job.groupId, via: 'none', reason: 'no_time' })
    return
  }
  const result: GroupPushResult = await pushToGroupWithinBudget(deps, {
    purpose: key.startsWith('file_failed') ? 'file_failed' : 'file_saved', groupId: job.groupId, lineGroupId: job.lineGroupId,
    messages: [card], reserve: FILE_SAVED_PUSH_RESERVE, retryKey: retryKeyFrom(key),
  })
  log('file_card', { groupId: job.groupId, via: 'push', result })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const IMAGE_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic' }

function mimeOf(job: FileJob, contentType: string | null): string {
  const t = contentType?.split(';')[0].trim().toLowerCase()
  if (t) return t
  return job.messageType === 'image' ? 'image/jpeg' : 'application/octet-stream'
}

/** A file keeps the name LINE gives; a photo has none, so it is named by its send time
 *  (Bangkok) and LINE message ID, which keeps names unique in the folder. */
function nameOf(job: FileJob, mimeType: string): string {
  if (job.messageType === 'file' && job.fileName) return job.fileName
  const p = bangkokParts(job.sentAt)
  const pad = (n: number) => String(n).padStart(2, '0')
  const sec = pad(new Date(job.sentAt.getTime()).getUTCSeconds())
  const ext = IMAGE_EXT[mimeType] ?? (job.messageType === 'image' ? 'jpg' : 'bin')
  const stem = job.messageType === 'image' ? 'photo' : 'file'
  return `${stem}-${p.y}${pad(p.m)}${pad(p.d)}-${pad(p.hh)}${pad(p.mm)}${sec}-${job.lineMessageId}.${ext}`
}
