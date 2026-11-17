import { bubble, button, caption, header, nextStepCard, text, uri } from '../line/flex-ui'
import { liffUrl } from '../liff-links'
import type { LineMessage } from '../line/types'

// #4 The "saved" and "couldn't save" cards (Figma UI v4 design system, same building blocks
// as the other cards). A saved file's link opens without a Google account when the Project
// folder holds the "anyone with the link can view" share (#13); the card says so only then.
// When a Google Workspace policy refused that share, the card says the link is for the
// Drive's owner; when the save did not check (a duplicate), it says neither.

const NAME_MAX = 80

export const FILE_SAVED_TEXT = {
  fileTitle: 'บันทึกไฟล์ลง Google Drive แล้ว',
  photoTitle: 'บันทึกรูปลง Google Drive แล้ว',
  photosTitle: (n: number) => `บันทึกรูป ${n} รูปลง Google Drive แล้ว`,
  // #141: a duplicate has its own title, so it does not read as a second copy.
  fileDuplicateTitle: 'ไฟล์นี้เคยบันทึกไว้แล้ว',
  photoDuplicateTitle: 'รูปนี้เคยบันทึกไว้แล้ว',
  duplicate: 'ไม่ได้บันทึกซ้ำ ใช้ลิงก์เดิมได้เลย',
  noAccount: 'เปิดลิงก์ได้เลย ไม่ต้องมีบัญชี Google',
  ownerOnly: 'ลิงก์นี้เปิดได้เฉพาะเจ้าของ Drive (Workspace ไม่อนุญาตให้แชร์ลิงก์)',
  photosFailedToo: (n: number) => `อีก ${n} รูปบันทึกไม่ได้`,
  failedTitle: 'น้องจดดีบันทึกไฟล์นี้ไม่ได้',
  photoFailedTitle: 'น้องจดดีบันทึกรูปนี้ไม่ได้',
  photosFailedTitle: (n: number) => `น้องจดดีบันทึกรูป ${n} รูปไม่ได้`,
  failedBody: 'กรุณาบันทึกไฟล์เองก่อนที่ไฟล์ใน LINE จะหมดอายุ',
  tooLarge: 'ไฟล์ใหญ่เกิน 100 MB',
  // #99: why the save failed, shown above failedBody.
  // #148: a save has about one minute; files near 100 MB often need longer.
  timeout: 'ไฟล์ใหญ่หรือเครือข่ายช้า บันทึกไม่ทันเวลา (น้องจดดีมีเวลาราว 1 นาทีต่อไฟล์) ลองส่งใหม่ หรืออัปโหลดลง Google Drive เอง',
  gone: 'LINE ไม่มีไฟล์นี้แล้ว อาจถูกยกเลิกการส่ง',
  driveFull: 'Google Drive ของเจ้าของบอทเต็ม ให้เจ้าของบอทลบไฟล์หรือเพิ่มพื้นที่',
  failed: 'ระบบขัดข้องชั่วคราว ลองส่งใหม่อีกครั้ง',
  openFile: 'เปิดไฟล์',
  openFolder: 'เปิดโฟลเดอร์',
} as const

/** 1234 -> "1.2 KB". Bytes as LINE and Drive count them (1 KB = 1024 bytes). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`
}

/** One file, or one photo sent alone. */
/** The line about who can open the link: null = not known here, so nothing is said. */
function accessCaption(linkShared: boolean | null) {
  if (linkShared === null) return []
  return [caption(linkShared ? FILE_SAVED_TEXT.noAccount : FILE_SAVED_TEXT.ownerOnly)]
}

export function fileSavedCard(p: {
  kind: 'file' | 'image'; fileName: string; sizeBytes: number | null; driveLink: string; duplicate: boolean
  linkShared: boolean | null
}): LineMessage {
  const image = p.kind === 'image'
  const t = p.duplicate
    ? (image ? FILE_SAVED_TEXT.photoDuplicateTitle : FILE_SAVED_TEXT.fileDuplicateTitle)
    : (image ? FILE_SAVED_TEXT.photoTitle : FILE_SAVED_TEXT.fileTitle)
  const name = p.fileName.length > NAME_MAX ? `${p.fileName.slice(0, NAME_MAX - 1)}…` : p.fileName
  return {
    type: 'flex',
    altText: `${t}: ${name}`,
    contents: bubble(
      [
        header(p.duplicate ? 'info' : 'success', t),
        text(name, { weight: 'bold' }),
        ...(p.sizeBytes !== null ? [caption(formatSize(p.sizeBytes))] : []),
        ...(p.duplicate ? [caption(FILE_SAVED_TEXT.duplicate)] : []),
        ...accessCaption(p.linkShared),
      ],
      [button('primary', uri(FILE_SAVED_TEXT.openFile, p.driveLink))],
    ),
  }
}

/** One card for a photo batch (LINE imageSet): the count saved, the count that failed,
 *  and the group's folder (or a saved photo when the folder ID is not known). */
export function photosSavedCard(p: {
  count: number; failed: number; link: string | null; isFolder: boolean; linkShared: boolean | null
  /** #99: why the failed photos were not saved (sharedReason); only read when failed > 0. */
  failedReason?: string
}): LineMessage {
  const t = FILE_SAVED_TEXT.photosTitle(p.count)
  return {
    type: 'flex',
    altText: t,
    contents: bubble(
      [
        header('success', t),
        ...(p.failed > 0
          ? [caption(`${FILE_SAVED_TEXT.photosFailedToo(p.failed)}: ${failReasonCaption(p.failedReason ?? 'failed')}`)]
          : []),
        ...accessCaption(p.linkShared),
      ],
      p.link ? [button('primary', uri(p.isFolder ? FILE_SAVED_TEXT.openFolder : FILE_SAVED_TEXT.openFile, p.link))] : [],
    ),
  }
}

/** #99: the caption that says why a save failed. An unknown reason reads as `failed`. */
export function failReasonCaption(reason: string): string {
  switch (reason) {
    case 'too_large': return FILE_SAVED_TEXT.tooLarge
    case 'timeout': return FILE_SAVED_TEXT.timeout
    case 'gone': return FILE_SAVED_TEXT.gone
    case 'drive_full': return FILE_SAVED_TEXT.driveFull
    default: return FILE_SAVED_TEXT.failed
  }
}

/** #99: the one reason a batch's failed photos share, else the generic `failed`. */
export function sharedReason(reasons: string[]): string {
  return reasons.length > 0 && reasons.every((r) => r === reasons[0]) ? reasons[0] : 'failed'
}

/** A file or a photo sent alone that could not be saved (no retry). */
export function fileFailedCard(p: { kind: 'file' | 'image'; fileName: string | null; reason: string }): LineMessage {
  const t = p.kind === 'image' ? FILE_SAVED_TEXT.photoFailedTitle : FILE_SAVED_TEXT.failedTitle
  const name = p.fileName && p.fileName.length > NAME_MAX ? `${p.fileName.slice(0, NAME_MAX - 1)}…` : p.fileName
  return {
    type: 'flex',
    altText: name ? `${t}: ${name}` : t,
    contents: bubble([
      header('danger', t),
      ...(name ? [text(name, { weight: 'bold' })] : []),
      caption(failReasonCaption(p.reason)),
      caption(FILE_SAVED_TEXT.failedBody),
    ]),
  }
}

/** A photo batch none of whose photos could be saved. */
export function photosFailedCard(p: { count: number; reason: string }): LineMessage {
  const t = FILE_SAVED_TEXT.photosFailedTitle(p.count)
  return {
    type: 'flex',
    altText: t,
    contents: bubble([header('danger', t), caption(failReasonCaption(p.reason)), caption(FILE_SAVED_TEXT.failedBody)]),
  }
}

const PAUSE_TAIL = 'บันทึกไฟล์เองก่อนที่ไฟล์ใน LINE จะหมดอายุนะ'

/** #99: text replies. The pause notice goes out at most once per group per Bangkok day;
 *  "saving" answers a large file at once, before the download. */
export const FILE_NOTICE_TEXT = {
  noOwner: `ยังบันทึกไฟล์ไม่ได้ เพราะกลุ่มนี้ยังไม่มีเจ้าของบอท\n${PAUSE_TAIL}`,
  noDrive: `ยังบันทึกไฟล์ไม่ได้ เพราะเจ้าของบอทยังไม่ได้เชื่อม Google Drive\n${PAUSE_TAIL}`,
  // UX review 2.1: the card form of the notices above.
  pausedTitle: 'ยังเก็บไฟล์ไม่ได้',
  noOwnerBody: 'กลุ่มนี้ยังไม่มีเจ้าของบอท ตั้งค่ากลุ่มก่อน แล้วน้องจดดีจะเก็บไฟล์ให้',
  ownerLeftBody: 'เจ้าของบอทออกจากกลุ่มแล้ว ใครจะเป็นเจ้าของคนใหม่ กดปุ่มด้านล่าง',
  noDriveBody: 'เจ้าของบอทเชื่อม Google Drive ก่อน แล้วน้องจดดีจะเก็บไฟล์ต่อจากนี้ให้',
  pauseNote: PAUSE_TAIL,
  setupButton: 'ตั้งค่ากลุ่ม',
  ownerButton: 'เป็นเจ้าของบอทแทน',
  driveButton: 'เชื่อม Google Drive',
  saving: (name: string) => `กำลังบันทึก ${name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name} ลง Google Drive…`,
  /** #148: added to the saving notice above SLOW_FILE_BYTES. */
  slowWarning: 'ไฟล์ใหญ่มาก อาจบันทึกไม่ทันใน 1 นาที ถ้าไม่สำเร็จ น้องจดดีจะแจ้ง แล้วอัปโหลดลง Google Drive เองได้',
} as const

/** UX review 2.1: why a file was not saved, with the button that fixes it. */
export function filePausedCard(p: { reason: 'no_owner' | 'owner_left' | 'no_drive'; liffId: string; groupId: string }): LineMessage {
  const T = FILE_NOTICE_TEXT
  const fix = p.reason === 'no_owner'
    ? uri(T.setupButton, liffUrl(p.liffId, 'setup', p.groupId))
    : p.reason === 'owner_left'
      ? uri(T.ownerButton, liffUrl(p.liffId, 'owner', p.groupId))
      : uri(T.driveButton, liffUrl(p.liffId, 'google'))
  const body = p.reason === 'no_owner' ? T.noOwnerBody : p.reason === 'owner_left' ? T.ownerLeftBody : T.noDriveBody
  return nextStepCard({
    tone: 'warning', title: T.pausedTitle, body, note: T.pauseNote, button: fix,
    altText: p.reason === 'no_drive' ? T.noDrive : T.noOwner,
  })
}

export function driveFolderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}
