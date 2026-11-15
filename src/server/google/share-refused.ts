import { bubble, button, header, text, uri } from '../line/flex-ui'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log } from '../log'
import type { Deps, DriveContext } from '../ports'

// #4 follow-up: Google refused the Project folder's "anyone with the link can view" share
// (a Google Workspace policy that blocks link sharing). The folder ID is stored anyway and
// files are still saved, but their links open for the Drive's owner only. The Owner gets one
// card in the Project's main group, as for lost access (#14), asking to let link sharing
// through or to connect another Google account.
//
// Once per Project folder, with no new column: the webhook_events ledger (insert on conflict
// do nothing) takes a row keyed `drive_share_refused:<folder ID>`, and only the run that
// inserted it posts. A push skipped near the quota is not repeated.

/** As the lost-access card: sent once and nothing repeats it. */
export const SHARE_REFUSED_PUSH_RESERVE = 0.02
/** The LINE steps of the card (quota and member count together, then the push). */
export const SHARE_REFUSED_CALLS = 2

export const SHARE_REFUSED_TEXT = {
  title: 'ลิงก์ไฟล์เปิดได้เฉพาะเจ้าของ Drive',
  body: 'Google Workspace ของเจ้าของบอทไม่อนุญาตให้แชร์แบบ "ทุกคนที่มีลิงก์" น้องจดดียังเก็บไฟล์ให้ตามปกติ แต่สมาชิกจะเปิดลิงก์ไม่ได้ จนกว่าผู้ดูแล Workspace จะเปิดการแชร์ลิงก์ หรือเจ้าของบอทเชื่อมบัญชี Google อื่น',
  button: 'เปลี่ยนบัญชี Google',
} as const

export function shareRefusedCard(liffId: string): LineMessage {
  return {
    type: 'flex',
    altText: SHARE_REFUSED_TEXT.title,
    contents: bubble(
      [header('warning', SHARE_REFUSED_TEXT.title), text(SHARE_REFUSED_TEXT.body, { color: '#545454' })],
      [button('primary', uri(SHARE_REFUSED_TEXT.button, liffUrl(liffId, 'google')))],
    ),
  }
}

/** The ledger key that makes the card once-only for this folder. */
export function shareRefusedKey(folderId: string): string {
  return `drive_share_refused:${folderId}`
}

export async function notifyShareRefused(deps: Deps, ctx: DriveContext, folderId: string): Promise<void> {
  if (!ctx.mainGroup) return
  const key = shareRefusedKey(folderId)
  const { inserted } = await deps.store.recordWebhookEvent({
    webhookEventId: key, eventType: 'drive_share_refused', lineGroupId: ctx.mainGroup.lineGroupId,
    eventTimestamp: deps.now(), isRedelivery: false,
  })
  if (!inserted) return
  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'drive_share_refused', groupId: ctx.mainGroup.groupId, lineGroupId: ctx.mainGroup.lineGroupId,
    messages: [shareRefusedCard(deps.config.liffId)], reserve: SHARE_REFUSED_PUSH_RESERVE, retryKey: retryKeyFrom(key),
  })
  log('drive_share_refused', { projectId: ctx.projectId, prompt: result })
}
