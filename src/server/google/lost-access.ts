import { liffUrl } from '../liff-links'
import { type GroupPushResult, pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { log } from '../log'
import type { Deps, DriveContext } from '../ports'

// #14: lost Google access. When Google answers a refresh with invalid_grant (the Owner
// revoked the app, or the grant expired), the account is marked revoked and the Project's
// main group gets one card with a sign-in button. Nothing else changes: Tasks, the Drive
// connection row and the folder IDs all stay, so the same account picks up where it
// stopped after a new sign-in.
//
// Once per revocation, with no new column: the card is posted only by the run whose
// UPDATE moved token_status from 'valid' to 'revoked' (markGoogleAccountRevoked). Later
// runs read 'revoked' and stop before they try the token. A push that is skipped near the
// LINE quota, or fails, is not sent again: the notice in the LIFF Google view and the
// card in the 1:1 chat still ask for the sign-in.

/** Share of the monthly LINE quota this card leaves unspent. As small as the reminders'
 *  and the setup card's: it is sent once and nothing repeats it. */
export const LOST_ACCESS_PUSH_RESERVE = 0.02

/** The LINE steps of the card, as Drive work counts time (drive-folders.ts checkTime): the
 *  member count and quota reads run together, then the push. */
export const LOST_ACCESS_CALLS = 2

/** A buttons card: text at most 160 characters, label at most 20 (LINE's limits). The
 *  button opens the LIFF Google view, which shows the sign-in notice. No name is on it. */
export function signInAgainCard(liffId: string): LineMessage {
  return {
    type: 'template',
    altText: 'กรุณาเข้าสู่ระบบ Google อีกครั้ง',
    template: {
      type: 'buttons',
      text: 'น้องจดดีเข้าถึง Google Drive ของเจ้าของบอทไม่ได้แล้ว จึงยังเก็บไฟล์ใหม่ไม่ได้ งานทั้งหมดยังอยู่ครบ เจ้าของบอทกดปุ่มด้านล่างเพื่อเข้าสู่ระบบ Google อีกครั้ง',
      actions: [{ type: 'uri', label: 'เข้าสู่ระบบ Google', uri: liffUrl(liffId, 'google') }],
    },
  }
}

/** Called by a Drive run whose refresh was answered invalid_grant, with the ciphertext of
 *  the token it tried. Marks the account and, only if this call did the marking, posts the
 *  card in the Project's main group through the push budget. Never touches Tasks. */
export async function markAccessLost(
  deps: Deps, ctx: DriveContext, account: { id: string; refreshTokenCiphertext: string },
): Promise<void> {
  const { revoked } = await deps.store.markGoogleAccountRevoked(account.id, account.refreshTokenCiphertext)
  // false: another run marked it first (that run posts), or the Owner has signed in again
  // since this run read the token.
  if (!revoked) return
  let prompt: GroupPushResult | 'no_main_group' = 'no_main_group'
  if (ctx.mainGroup) {
    prompt = await pushToGroupWithinBudget(deps, {
      purpose: 'drive_revoked',
      groupId: ctx.mainGroup.groupId,
      lineGroupId: ctx.mainGroup.lineGroupId,
      messages: [signInAgainCard(deps.config.liffId)],
      reserve: LOST_ACCESS_PUSH_RESERVE,
      // The time makes the key new for each revocation: LINE drops a repeated key for 24 h.
      retryKey: retryKeyFrom(`drive_revoked:${account.id}:${deps.now().toISOString()}`),
    })
  }
  // IDs only.
  log('drive_access_lost', { projectId: ctx.projectId, googleAccountId: account.id, prompt })
}
