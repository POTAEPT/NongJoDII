import { createHash } from 'node:crypto'
import { DRIVE_HARD_STOP_MS, DriveTimeUp, openGroupDrive } from '../google/drive-folders'
import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { log, logError } from '../log'
import { ownerBackedOn } from '../members/owner-left'
import type { Deps, SavedFile } from '../ports'
import { bangkokParts } from '../time/bangkok'
import type { Job } from '../webhook/ingest'
import { driveFolderLink, fileSavedCard, photosSavedCard } from './card'

// #4 Feature 1, file saver. A file or image sent in a group of a Project is downloaded from
// LINE at once (the webhook carries only its ID), hashed, and uploaded to that group's Drive
// folder (main group: "Main group files"; Sub group: its own folder, #13) through the Project's
// active Drive connection. Then the bot posts a "saved" card with the link.
//
// Time. The job runs inside the webhook's after() (route maxDuration 60 s), timed from the
// moment the request came in (`receivedAt`). Every step gets only the time left until
// DRIVE_HARD_STOP_MS (55 s), so a save that cannot finish stops cleanly (logged). The card
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
// requests. Each job, after its own photo has a files row, counts the batch in the database:
// with imageSet.total, the batch is complete when that many photos are saved; without it
// (LINE 11.15 or earlier on Android) the job waits BATCH_QUIET_MS and then checks that every
// stored photo of the set is saved. A complete batch is claimed in image_set_cards, so
// exactly one job posts the one "saved N photos" card.
//
// Pauses: nothing is saved while the group has no confirmed Owner (owner_confirmed_at is
// cleared when the Owner leaves, #30), when the setup form turned file saving off, or when
// Drive access is lost: then the #14 path marks the account and asks the Owner once to sign
// in again, and no files row is written. The message row stays either way.

export const REPLY_WINDOW_MS = 50_000
export const SAVE_HARD_STOP_MS = DRIVE_HARD_STOP_MS
/** Files above this are not saved: the whole file is held in memory to hash and upload it. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024
/** A batch without imageSet.total: how long the last saver waits for more photos. */
export const BATCH_QUIET_MS = 3_000
/** Share of the monthly quota a saved card leaves unspent: as the Tasks-created post. */
export const FILE_SAVED_PUSH_RESERVE = 0.1
/** A step needs at least this much time left to start. */
const MIN_STEP_MS = 1_000

type FileJob = Extract<Job, { kind: 'group_file' }>

export type FileSaveOutcome =
  | 'saved' | 'duplicate' | 'paused' | 'too_large' | 'gone' | 'no_drive' | 'failed' | 'timeout'

export async function handleGroupFile(deps: Deps, job: FileJob): Promise<FileSaveOutcome> {
  const deadline = job.receivedAt.getTime() + SAVE_HARD_STOP_MS
  const left = () => deadline - deps.now().getTime()
  const ids = { groupId: job.groupId, messageType: job.messageType }

  const group = await deps.store.getGroupById(job.groupId)
  // Paused while the Owner left (#30) or a Sub group waits for the take-over answer (#31):
  // both clear owner_confirmed_at.
  if (!group?.projectId || !ownerBackedOn(group)) return skipped(ids, 'paused', 'no_owner')
  const setup = await deps.store.getGroupSetup(job.groupId)
  if (!setup?.features.saveFiles) return skipped(ids, 'paused', 'feature_off')
  if (job.fileSize !== null && job.fileSize > MAX_FILE_BYTES) return skipped(ids, 'too_large', 'too_large')

  if (left() < MIN_STEP_MS) return skipped(ids, 'timeout', 'download')
  let content: { data: Uint8Array; contentType: string | null } | null
  try {
    content = await deps.line.getMessageContent(job.lineMessageId, { timeoutMs: left() })
  } catch (err) {
    logError('file_download_failed', ids, err)
    return 'failed'
  }
  if (!content) return skipped(ids, 'gone', 'gone')
  if (content.data.byteLength > MAX_FILE_BYTES) return skipped(ids, 'too_large', 'too_large')
  const sha256 = createHash('sha256').update(content.data).digest('hex')

  let file: SavedFile
  let duplicate = false
  const existing = await deps.store.findFileByHash(job.groupId, sha256)
  if (existing) {
    // Saved before: no Google call, so a duplicate is answered even while Drive access is lost.
    await deps.store.linkFileToMessage(existing.id, job.storedMessageId)
    file = existing
    duplicate = true
  } else {
    let drive
    try {
      drive = await openGroupDrive(deps, job.groupId, new Date(deadline))
    } catch (err) {
      if (err instanceof DriveTimeUp) return skipped(ids, 'timeout', 'drive')
      logError('file_drive_failed', ids, err)
      return 'failed'
    }
    // Logged inside: no usable account, the token was revoked (#14 card), or another
    // Google account holds the Project.
    if (!drive) return skipped(ids, 'no_drive', 'no_drive')
    const connection = await deps.store.findActiveDriveConnection(drive.projectId)
    if (!connection || connection.googleAccountId !== drive.googleAccountId) return skipped(ids, 'no_drive', 'other_account')
    if (left() < MIN_STEP_MS) return skipped(ids, 'timeout', 'upload')
    const mimeType = mimeOf(job, content.contentType)
    const fileName = nameOf(job, mimeType)
    let uploaded: { id: string; webViewLink: string }
    try {
      uploaded = await deps.google.uploadFile(
        drive.accessToken, { name: fileName, parentId: drive.folderId, mimeType, data: content.data }, { timeoutMs: left() },
      )
    } catch (err) {
      logError('file_upload_failed', ids, err)
      return 'failed'
    }
    const result = await deps.store.insertFile({
      groupId: job.groupId, messageId: job.storedMessageId, senderLineUserId: job.senderLineUserId,
      driveConnectionId: connection.id, fileName, contentSha256: sha256, driveFileId: uploaded.id,
      driveLink: uploaded.webViewLink, sentAt: job.sentAt, savedAt: deps.now(), sizeBytes: content.data.byteLength,
    })
    file = result.file
    if (!result.inserted) {
      // The same content was saved by another job at the same moment. Ours is a second copy
      // in Drive, left there (no code deletes files in the Owner's Drive).
      log('file_saved_twice', { groupId: job.groupId })
      await deps.store.linkFileToMessage(file.id, job.storedMessageId)
      duplicate = true
    }
  }
  log('file_saved', { ...ids, duplicate, sizeBytes: file.sizeBytes })
  await announce(deps, job, file, duplicate)
  return duplicate ? 'duplicate' : 'saved'
}

function skipped(ids: { groupId: string; messageType: string }, outcome: FileSaveOutcome, reason: string): FileSaveOutcome {
  log('file_save_skipped', { ...ids, reason })
  return outcome
}

/** The card for this message: its own card, or (a photo of a batch) the batch card when
 *  this job is the one that claims the complete batch. */
async function announce(deps: Deps, job: FileJob, file: SavedFile, duplicate: boolean): Promise<void> {
  if (!job.imageSet) {
    const card = fileSavedCard({
      kind: job.messageType, fileName: file.fileName, sizeBytes: file.sizeBytes, driveLink: file.driveLink, duplicate,
    })
    await sendCard(deps, job, card, `file_saved:${job.storedMessageId}`)
    return
  }
  const { id: imageSetId, total } = job.imageSet
  let count: number
  if (total !== null) {
    const c = await deps.store.countImageSet(job.groupId, imageSetId)
    if (c.saved < total) return // a photo still to come saves last and posts
    count = total
  } else {
    // No photo is known to be last: wait for the rest of the batch to arrive and save.
    await (deps.sleep ?? defaultSleep)(BATCH_QUIET_MS)
    const c = await deps.store.countImageSet(job.groupId, imageSetId)
    if (c.saved < c.messages) return // another photo is still saving; it checks again
    count = c.saved
  }
  const { claimed } = await deps.store.claimImageSetCard(job.groupId, imageSetId)
  if (!claimed) return
  const folderId = await groupFolderId(deps, job.groupId)
  const card = photosSavedCard({
    count, link: folderId ? driveFolderLink(folderId) : file.driveLink, isFolder: folderId !== null,
  })
  await sendCard(deps, job, card, `photos_saved:${job.groupId}:${imageSetId}`)
}

/** The group's stored Drive folder ID (no Google call). */
async function groupFolderId(deps: Deps, groupId: string): Promise<string | null> {
  try {
    const group = await deps.store.getGroupById(groupId)
    if (!group?.projectId) return null
    const ctx = await deps.store.getDriveContext(group.projectId)
    return [ctx?.mainGroup, ...(ctx?.subGroups ?? [])].find((g) => g?.groupId === groupId)?.folderId ?? null
  } catch (err) {
    logError('file_folder_read_failed', { groupId }, err)
    return null
  }
}

/** Reply while the reply token is surely still valid, else a push inside the push budget. */
async function sendCard(deps: Deps, job: FileJob, card: LineMessage, key: string): Promise<void> {
  const elapsed = deps.now().getTime() - job.receivedAt.getTime()
  if (job.replyToken && elapsed <= REPLY_WINDOW_MS) {
    try {
      await deps.line.reply(job.replyToken, [card])
      log('file_card', { groupId: job.groupId, via: 'reply' })
    } catch (err) {
      // Not pushed instead: the reply may have reached the group. The file is on the Dashboard.
      logError('file_card_reply_failed', { groupId: job.groupId }, err)
    }
    return
  }
  const result: GroupPushResult = await pushToGroupWithinBudget(deps, {
    purpose: 'file_saved', groupId: job.groupId, lineGroupId: job.lineGroupId, messages: [card],
    reserve: FILE_SAVED_PUSH_RESERVE, retryKey: retryKeyFrom(key),
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
