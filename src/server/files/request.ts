import { log, logError } from '../log'
import type { LineMessage } from '../line/types'
import type { Deps } from '../ports'

// #33: the answer to a quote-reply "NongJoDII ขอไฟล์". LINE never returns the quoted
// content, only quotedMessageId, so the bot finds the file through its stored copy of the
// quoted message and that message's files row (written by #4). Always a reply, never a
// push. Bots cannot send LINE file messages, so the answer is the Drive link; it opens
// without a Google account because the Project folder is shared "anyone with the link"
// (#13).

export const FILE_REQUEST_TEXT = {
  howTo: 'ตอบกลับ (Reply) ข้อความไฟล์ที่ต้องการ แล้วพิมพ์ "น้องจดดี ขอไฟล์" เพื่อรับลิงก์ Google Drive ของไฟล์นั้น',
  noFile: 'ข้อความนี้ไม่มีไฟล์ที่น้องจดดีบันทึกไว้',
  // An unsent message is deleted (#24), so it reads the same as one the bot never stored.
  unknown: 'ไม่พบข้อความนี้ อาจถูกยกเลิกการส่งไปแล้ว หรือส่งมาก่อนน้องจดดีจะบันทึก',
  linkIntro: 'ลิงก์ไฟล์',
} as const

export function fileLinkReply(p: { fileName: string; driveLink: string }): LineMessage {
  return { type: 'text', text: `${FILE_REQUEST_TEXT.linkIntro} "${p.fileName}"\n${p.driveLink}` }
}

const text = (t: string): LineMessage => ({ type: 'text', text: t })

export async function handleFileRequest(
  deps: Deps,
  p: { groupId: string; quotedMessageId: string | null; replyToken: string },
): Promise<void> {
  let message: LineMessage
  let outcome: string
  if (p.quotedMessageId === null) {
    message = text(FILE_REQUEST_TEXT.howTo)
    outcome = 'no_quote'
  } else {
    const found = await deps.store.findQuotedFile(p.groupId, p.quotedMessageId)
    outcome = found.kind
    message = found.kind === 'file'
      ? fileLinkReply(found)
      : text(found.kind === 'no_file' ? FILE_REQUEST_TEXT.noFile : FILE_REQUEST_TEXT.unknown)
  }
  // Best effort: a failed reply is logged; the person can ask again.
  try {
    await deps.line.reply(p.replyToken, [message])
    log('file_request_replied', { groupId: p.groupId, outcome })
  } catch (err) {
    logError('file_request_reply_failed', { groupId: p.groupId, outcome }, err)
  }
}
