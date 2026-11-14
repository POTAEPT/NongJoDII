import { liffUrl } from '@/server/liff-links'
import { logError } from '@/server/log'
import type { Deps } from '@/server/ports'

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
    // #14: the button opens the LIFF Google view, where the Owner can change the account.
    await deps.line.reply(job.replyToken, [
      {
        type: 'template',
        altText: 'เชื่อม Google Drive ไว้แล้ว',
        template: {
          type: 'buttons',
          text: 'เชื่อม Google Drive ไว้แล้ว น้องจดดีจะเก็บไฟล์ของกลุ่มลงไดรฟ์ของคุณ',
          actions: [{ type: 'uri', label: 'จัดการ Google Drive', uri: liffUrl(deps.config.liffId, 'google') }],
        },
      },
    ])
    return
  }
  await deps.line.reply(job.replyToken, [
    {
      type: 'template',
      altText: 'เชื่อม Google Drive',
      template: {
        type: 'buttons',
        text: 'เชื่อม Google Drive ของคุณ เพื่อให้น้องจดดีเก็บไฟล์ของกลุ่มที่คุณเป็นเจ้าของไว้ในไดรฟ์ของคุณเอง',
        actions: [{ type: 'uri', label: 'เชื่อม Google Drive', uri: liffUrl(deps.config.liffId, 'google') }],
      },
    },
  ])
}
