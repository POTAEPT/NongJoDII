import { sealState } from '../crypto/secretbox'
import { requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps } from '../ports'

/** POST /api/google/start. The Owner comes only from the verified LIFF ID token;
 *  any other body field (e.g. a client-sent lineUserId) is ignored, except `change`.
 *
 *  `change: true` (#14) starts a change of the connected Google account: only the
 *  confirmed Owner of a Project may. The intent is sealed into the OAuth state, and the
 *  callback retires an old Drive connection only for a state that carries it
 *  (change-account.ts). Every other sign-in, with whatever Google account, retires
 *  nothing. */
export async function startGoogleSignIn(deps: Deps, body: unknown): Promise<ApiResult> {
  const fields = typeof body === 'object' && body !== null ? (body as { idToken?: unknown; change?: unknown }) : {}
  const user = await requireLiffUser(deps, fields.idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const change = fields.change === true
  if (change && (await deps.store.listConfirmedOwnerProjects(user.lineUserId)).length === 0) {
    return { status: 403, body: { error: 'not_owner' } }
  }
  const state = sealState(user.lineUserId, deps.now(), deps.config.tokenEncryptionKey, { change })
  return { status: 200, body: { url: deps.google.buildAuthUrl(state) } }
}
