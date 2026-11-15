import { bubble, button, caption, header, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'

// #4 The "saved" cards (Figma UI v4 design system, same building blocks as the other cards).
// The link opens without a Google account: saved files sit in the Project folder, which is
// shared once as "anyone with the link can view" (#13), and inherit that sharing.

const NAME_MAX = 80

export const FILE_SAVED_TEXT = {
  fileTitle: 'บันทึกไฟล์ลง Google Drive แล้ว',
  photoTitle: 'บันทึกรูปลง Google Drive แล้ว',
  photosTitle: (n: number) => `บันทึกรูป ${n} รูปลง Google Drive แล้ว`,
  duplicate: 'ไฟล์นี้เคยบันทึกไว้แล้ว ใช้ลิงก์เดิม',
  noAccount: 'เปิดลิงก์ได้เลย ไม่ต้องมีบัญชี Google',
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
export function fileSavedCard(p: {
  kind: 'file' | 'image'; fileName: string; sizeBytes: number | null; driveLink: string; duplicate: boolean
}): LineMessage {
  const t = p.kind === 'image' ? FILE_SAVED_TEXT.photoTitle : FILE_SAVED_TEXT.fileTitle
  const name = p.fileName.length > NAME_MAX ? `${p.fileName.slice(0, NAME_MAX - 1)}…` : p.fileName
  return {
    type: 'flex',
    altText: `${t}: ${name}`,
    contents: bubble(
      [
        header('success', t),
        text(name, { weight: 'bold' }),
        ...(p.sizeBytes !== null ? [caption(formatSize(p.sizeBytes))] : []),
        ...(p.duplicate ? [caption(FILE_SAVED_TEXT.duplicate)] : []),
        caption(FILE_SAVED_TEXT.noAccount),
      ],
      [button('primary', uri(FILE_SAVED_TEXT.openFile, p.driveLink))],
    ),
  }
}

/** One card for a photo batch (LINE imageSet): the count and the group's folder. */
export function photosSavedCard(p: { count: number; link: string; isFolder: boolean }): LineMessage {
  const t = FILE_SAVED_TEXT.photosTitle(p.count)
  return {
    type: 'flex',
    altText: t,
    contents: bubble(
      [header('success', t), caption(FILE_SAVED_TEXT.noAccount)],
      [button('primary', uri(p.isFolder ? FILE_SAVED_TEXT.openFolder : FILE_SAVED_TEXT.openFile, p.link))],
    ),
  }
}

export function driveFolderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}
