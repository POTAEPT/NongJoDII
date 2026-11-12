import { requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps } from '../ports'

/** POST /api/google/status. Tells the LIFF page whether the verified LINE user has
 *  a usable Google account. Only the ID token is read from the body. */
export async function googleStatus(deps: Deps, body: unknown): Promise<ApiResult> {
  const idToken = typeof body === 'object' && body !== null ? (body as { idToken?: unknown }).idToken : undefined
  const user = await requireLiffUser(deps, idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const account = await deps.store.findGoogleAccountByLineUser(user.lineUserId)
  return { status: 200, body: { connected: account?.tokenStatus === 'valid' } }
}
