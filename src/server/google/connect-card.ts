import { bubble, button, header, iconRow, panel, postback, text, uri } from '@/server/line/flex-ui'
import type { LineMessage } from '@/server/line/types'
import { liffUrl } from '@/server/liff-links'
import { logError } from '@/server/log'
import type { Deps } from '@/server/ports'

// The 1:1 chat answer (Figma UI v4 #1 ต้อนรับ + เชื่อม Drive): a card that explains what
// connecting Drive does, with "เชื่อม Google Drive" and "ไว้ทีหลัง". "ไว้ทีหลัง" is a postback
// that only shows the user's choice in the chat: 1:1 postbacks are recorded, not answered.

export const CONNECT_TEXT = {
  title: 'เชื่อม Google Drive ของคุณ',
  intro: 'เพื่อให้ไฟล์จากกลุ่มที่คุณเป็นเจ้าของไม่หมดอายุ น้องจดดีจะเก็บไฟล์ไว้ใน Drive ของคุณเอง',
  folder: 'สร้างโฟลเดอร์ NongJoDII ใน Drive ของคุณ',
  scope: 'เข้าถึงเฉพาะไฟล์ที่น้องจดดีสร้างเท่านั้น',
  connect: 'เชื่อม Google Drive',
  later: 'ไว้ทีหลัง',
  connected: 'เชื่อม Google Drive ไว้แล้ว น้องจดดีจะเก็บไฟล์ของกลุ่มลงไดรฟ์ของคุณ',
} as const

/** Postback data of "ไว้ทีหลัง". No handler reads it (1:1 postbacks are only recorded). */
export const CONNECT_LATER_DATA = 'a=drive_later'

export function connectDriveCard(liffId: string): LineMessage {
  return {
    type: 'flex',
    altText: CONNECT_TEXT.connect,
    contents: bubble(
      [
        header('info', CONNECT_TEXT.title),
        text(CONNECT_TEXT.intro, { color: '#545454' }),
        panel([iconRow('📁', CONNECT_TEXT.folder), iconRow('🔒', CONNECT_TEXT.scope)]),
      ],
      [
        button('primary', uri(CONNECT_TEXT.connect, liffUrl(liffId, 'google'))),
        button('ghost', postback(CONNECT_TEXT.later, CONNECT_LATER_DATA)),
      ],
    ),
  }
}

export async function sendConnectDriveCard(
  deps: Deps,
  job: { lineUserId: string; replyToken: string | null },
): Promise<void> {
  if (!job.replyToken) return
  // If the lookup fails, fall back to the default "not connected" card: the user can still connect, and a
  // redundant card is harmless, whereas silence leaves them stuck.
  let account: Awaited<ReturnType<Deps['store']['findGoogleAccountByLineUser']>> = null
  try {
    account = await deps.store.findGoogleAccountByLineUser(job.lineUserId)
  } catch (err) {
    logError('connect_card_lookup_failed', {}, err)
  }
  if (account?.tokenStatus === 'valid') {
    await deps.line.reply(job.replyToken, [{ type: 'text', text: CONNECT_TEXT.connected }])
    return
  }
  await deps.line.reply(job.replyToken, [connectDriveCard(deps.config.liffId)])
}
