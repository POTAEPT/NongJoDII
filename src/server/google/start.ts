import { sealState } from '../crypto/secretbox'
import { requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps } from '../ports'

/** POST /api/google/start. The Owner comes only from the verified LIFF ID token;
 *  any other body field (e.g. a client-sent lineUserId) is ignored, except `change`.
 *
 *  `change: true` (#14) starts a change of the connected Google account: only the
 *  confirmed Owner of a Project may, and Google then shows its account chooser. The
 *  sign-in itself is the normal one; the callback sees that the account differs and
 *  retires the old Drive connection (change-account.ts). */
export async function startGoogleSignIn(deps: Deps, body: unknown): Promise<ApiResult> {
  const fields = typeof body === 'object' && body !== null ? (body as { idToken?: unknown; change?: unknown }) : {}
  const user = await requireLiffUser(deps, fields.idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const change = fields.change === true
  if (change && (await deps.store.listConfirmedOwnerProjects(user.lineUserId)).length === 0) {
    return { status: 403, body: { error: 'not_owner' } }
  }
  const state = sealState(user.lineUserId, deps.now(), deps.config.tokenEncryptionKey)
  return { status: 200, body: { url: deps.google.buildAuthUrl(state, { chooseAccount: change }) } }
}
