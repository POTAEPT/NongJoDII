import { sealState } from '../crypto/secretbox'
import { requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps } from '../ports'

/** POST /api/google/start. The Owner comes only from the verified LIFF ID token;
 *  any other body field (e.g. a client-sent lineUserId) is ignored. */
export async function startGoogleSignIn(deps: Deps, body: unknown): Promise<ApiResult> {
  const idToken = typeof body === 'object' && body !== null ? (body as { idToken?: unknown }).idToken : undefined
  const user = await requireLiffUser(deps, idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const state = sealState(user.lineUserId, deps.now(), deps.config.tokenEncryptionKey)
  return { status: 200, body: { url: deps.google.buildAuthUrl(state) } }
}
