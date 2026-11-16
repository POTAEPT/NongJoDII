import { open } from '../crypto/secretbox'
import { liffUrl } from '../liff-links'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { requireLiffUser } from '../liff-auth'
import { log, logError } from '../log'
import type { ApiResult, Defer, Deps } from '../ports'
import { LOST_ACCESS_PUSH_RESERVE } from './lost-access'

// #82: a person disconnects their Google Drive from the LIFF Google view.
//
// The grant is revoked at Google (oauth2.googleapis.com/revoke), then the account is marked
// 'revoked' with the same compare-and-set #14 uses (markGoogleAccountRevoked), which also
// clears the stored refresh token. Everything else stays as #14 leaves it: Tasks, the Drive
// connection row (kept as history) and the folder IDs, so signing in again with the same
// account picks up where it stopped. Files already saved stay in the person's Drive.
//
// Because this call does the marking, the #14 "access lost, sign in again" card is never
// posted for it (only the run whose UPDATE marked the account posts that card). Each main
// group whose Drive this account served gets one "the Owner disconnected" card instead, so
// the group knows why new files are not saved.

/** A buttons card: text at most 160 characters, label at most 20 (LINE's limits). */
export const DISCONNECTED_TEXT = {
  card: 'เจ้าของบอทยกเลิกการเชื่อม Google Drive แล้ว ไฟล์ใหม่ในกลุ่มจะยังไม่ถูกบันทึก ไฟล์ที่บันทึกไว้แล้วยังอยู่ใน Drive ของเจ้าของบอท',
  button: 'เชื่อม Drive ใหม่',
} as const

export function disconnectedCard(liffId: string): LineMessage {
  return {
    type: 'template',
    altText: 'เจ้าของบอทยกเลิกการเชื่อม Google Drive แล้ว',
    template: {
      type: 'buttons',
      text: DISCONNECTED_TEXT.card,
      actions: [{ type: 'uri', label: DISCONNECTED_TEXT.button, uri: liffUrl(liffId, 'google') }],
    },
  }
}

/** POST /api/google/disconnect { idToken }. Only the verified LINE user's own latest Google
 *  account is touched.
 *   200 { disconnected: true }: revoked at Google (or Google no longer held it) and marked.
 *   409 not_connected: no usable account (none, or already revoked or expired).
 *   502 google_failed: Google did not answer (5xx, timeout); nothing changed, try again. */
export async function disconnectGoogle(deps: Deps, body: unknown, defer: Defer): Promise<ApiResult> {
  const idToken = typeof body === 'object' && body !== null ? (body as { idToken?: unknown }).idToken : undefined
  const user = await requireLiffUser(deps, idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const account = await deps.store.findGoogleAccountToken(user.lineUserId)
  if (!account || account.tokenStatus !== 'valid' || account.refreshTokenCiphertext === null) {
    return { status: 409, body: { error: 'not_connected' } }
  }
  const sealed = account.refreshTokenCiphertext
  // A token that does not open (a changed key) cannot be revoked at Google; the account is
  // still marked, so the app stops using it.
  const refreshToken = open(sealed, deps.config.tokenEncryptionKey)
  if (refreshToken !== null) {
    try {
      await deps.google.revokeToken(refreshToken)
    } catch (err) {
      logError('google_disconnect_failed', { googleAccountId: account.id }, err)
      return { status: 502, body: { error: 'google_failed' } }
    }
  }
  const at = deps.now()
  const { revoked } = await deps.store.markGoogleAccountRevoked(account.id, sealed)
  // IDs only.
  log('google_disconnected', { googleAccountId: account.id, marked: revoked })
  // revoked false: a Drive run marked it a moment earlier (that run posts #14's card), or a
  // new sign-in replaced the token in between. Either way this call posts nothing.
  if (revoked) defer(() => announceDisconnected(deps, user.lineUserId, account.id, at))
  return { status: 200, body: { disconnected: true } }
}

/** One card in the main group of each Project whose active Drive connection is this account
 *  and whose confirmed Owner is this person. Best effort, through the push budget. */
async function announceDisconnected(deps: Deps, lineUserId: string, googleAccountId: string, at: Date): Promise<void> {
  try {
    for (const projectId of await deps.store.listConfirmedOwnerProjects(lineUserId)) {
      const ctx = await deps.store.getDriveContext(projectId)
      if (!ctx?.mainGroup || ctx.activeAccountId !== googleAccountId) continue
      const result = await pushToGroupWithinBudget(deps, {
        purpose: 'drive_disconnected',
        groupId: ctx.mainGroup.groupId,
        lineGroupId: ctx.mainGroup.lineGroupId,
        messages: [disconnectedCard(deps.config.liffId)],
        reserve: LOST_ACCESS_PUSH_RESERVE,
        // Once per disconnect: LINE drops a repeated key for 24 h.
        retryKey: retryKeyFrom(`drive_disconnected:${googleAccountId}:${projectId}:${at.toISOString()}`),
      })
      log('drive_disconnected_card', { projectId, result })
    }
  } catch (err) {
    logError('drive_disconnected_card_failed', { googleAccountId }, err)
  }
}
