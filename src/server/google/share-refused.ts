import { bubble, button, header, text, uri } from '../line/flex-ui'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log, logError } from '../log'
import { bangkokParts } from '../time/bangkok'
import type { Deps, DriveContext } from '../ports'

// #4 follow-up: Google refused the Project folder's "anyone with the link can view" share
// (a Google Workspace policy that blocks link sharing). The folder ID is stored anyway and
// files are still saved, but their links open for the Drive's owner only. The Owner gets one
// card in the Project's main group, as for lost access (#14), asking to let link sharing
// through or to connect another Google account.
//
// Once per Project folder, with no new column: the webhook_events ledger (insert on conflict
// do nothing) gets a row keyed `drive_share_refused:<folder ID>` only after LINE took the
// push, so a push skipped near the quota or failed is tried again at the next refusal. Two
// runs that both push at once send one card: the push's retry key is the same, and LINE
// drops the repeat.
//
// The refusal itself is remembered per Bangkok day (`drive_share_refused_check:<folder>:<day>`),
// so a refused folder costs no Google calls on later saves that day (drive-folders.ts).

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

/** The ledger key of a refusal seen on this Bangkok day. */
export function shareRefusedTodayKey(folderId: string, now: Date): string {
  const p = bangkokParts(now)
  return `drive_share_refused_check:${folderId}:${p.y}-${p.m}-${p.d}`
}

/** True when a share of this folder was refused earlier this Bangkok day. */
export async function refusedToday(deps: Deps, folderId: string): Promise<boolean> {
  return deps.store.hasWebhookEvent(shareRefusedTodayKey(folderId, deps.now()))
}

/** Remembers today's refusal (best effort: on a store error the next save checks again). */
export async function rememberRefusal(deps: Deps, ctx: DriveContext, folderId: string): Promise<void> {
  try {
    await deps.store.recordWebhookEvent({
      webhookEventId: shareRefusedTodayKey(folderId, deps.now()), eventType: 'drive_share_refused_check',
      lineGroupId: ctx.mainGroup?.lineGroupId ?? null, eventTimestamp: deps.now(), isRedelivery: false,
    })
  } catch (err) {
    logError('drive_share_refusal_record_failed', { projectId: ctx.projectId }, err)
  }
}

export async function notifyShareRefused(deps: Deps, ctx: DriveContext, folderId: string): Promise<void> {
  if (!ctx.mainGroup) return
  const key = shareRefusedKey(folderId)
  if (await deps.store.hasWebhookEvent(key)) return
  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'drive_share_refused', groupId: ctx.mainGroup.groupId, lineGroupId: ctx.mainGroup.lineGroupId,
    messages: [shareRefusedCard(deps.config.liffId)], reserve: SHARE_REFUSED_PUSH_RESERVE, retryKey: retryKeyFrom(key),
  })
  log('drive_share_refused', { projectId: ctx.projectId, prompt: result })
  // Only a card LINE took is remembered; a skipped or failed one is tried at the next refusal.
  if (result !== 'pushed') return
  await deps.store.recordWebhookEvent({
    webhookEventId: key, eventType: 'drive_share_refused', lineGroupId: ctx.mainGroup.lineGroupId,
    eventTimestamp: deps.now(), isRedelivery: false,
  })
}
