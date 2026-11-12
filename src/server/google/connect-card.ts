import { liffUrl } from '@/server/liff-links'
import type { Deps } from '@/server/ports'

export async function sendConnectDriveCard(
  deps: Deps,
  job: { lineUserId: string; replyToken: string | null },
): Promise<void> {
  if (!job.replyToken) return
  const account = await deps.store.findGoogleAccountByLineUser(job.lineUserId)
  if (account?.tokenStatus === 'valid') {
    await deps.line.reply(job.replyToken, [
      { type: 'text', text: 'เชื่อม Google Drive ไว้แล้ว น้องจดดีจะเก็บไฟล์ของกลุ่มลงไดรฟ์ของคุณ' },
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
