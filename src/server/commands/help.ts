import { bubble, button, caption, column, commandRow, header, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { log, logError } from '../log'
import type { Deps } from '../ports'
import { COMMAND_TEXT, commandQuickReply } from './quick-reply'

// UX review 1.3: the answer to "น้องจดดี วิธีใช้" (or the bot's name alone). A reply, so no
// push. Lists the commands people type, since a LINE group has no menu to discover them.

export const HELP_TEXT = {
  title: 'น้องจดดีทำอะไรได้บ้าง',
  summarize: 'สรุปแชตใหม่เป็นงาน ให้ทีมกดยืนยัน',
  settings: 'ตั้งค่ากลุ่ม ชื่อเล่น และเวลาเตือน',
  done: 'ปิดงานของฉันที่ยังไม่เสร็จ',
  requestFile: 'ตอบกลับข้อความไฟล์ แล้วพิมพ์คำนี้ เพื่อขอลิงก์ไฟล์',
  progress: 'พิมพ์ว่า "เสร็จแล้ว" ในแชตปกติได้เลย น้องจดดีจะถามว่าปิดงานไหนให้เอง',
  altText: 'น้องจดดีทำอะไรได้บ้าง: น้องจดดี สรุป · น้องจดดี ตั้งค่า · น้องจดดี done · น้องจดดี ขอไฟล์',
  guideButton: 'ดูวิธีใช้ทั้งหมด',
} as const

/** #133: the public how-to page on the app domain. A plain URL, no IDs. */
export function guideUrl(appBaseUrl: string): string {
  return `${appBaseUrl}/guide`
}

export function helpCard(appBaseUrl: string): LineMessage {
  return {
    type: 'flex',
    altText: HELP_TEXT.altText,
    contents: bubble([
      header('info', HELP_TEXT.title),
      column([
        commandRow(COMMAND_TEXT.summarize, HELP_TEXT.summarize),
        commandRow(COMMAND_TEXT.settings, HELP_TEXT.settings),
        commandRow(COMMAND_TEXT.done, HELP_TEXT.done),
        commandRow(COMMAND_TEXT.requestFile, HELP_TEXT.requestFile),
      ], { spacing: 'md' }),
      caption(HELP_TEXT.progress),
    ], [button('secondary', uri(HELP_TEXT.guideButton, guideUrl(appBaseUrl)))]),
    quickReply: commandQuickReply(),
  }
}

/** Best effort: a failed reply is logged; the person can ask again. */
export async function replyHelpCard(deps: Deps, p: { groupId: string; replyToken: string }): Promise<void> {
  try {
    await deps.line.reply(p.replyToken, [helpCard(deps.config.appBaseUrl)])
    log('help_card_replied', { groupId: p.groupId })
  } catch (err) {
    logError('help_card_failed', { groupId: p.groupId }, err)
  }
}
