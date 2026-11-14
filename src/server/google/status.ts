import { requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps } from '../ports'

/** POST /api/google/status. Tells the LIFF page about the verified LINE user's latest
 *  Google account. Only the ID token is read from the body.
 *   connected:   the account is usable.
 *   signInAgain: there is an account, but its grant was revoked or expired (#14).
 *   canChange:   connected, and the person is the confirmed Owner of a Project, so the
 *                page may offer "change Google account" (#14).
 *   changePending: connected, but a Project this person owns as confirmed Owner is still
 *                connected to another Google account: a change of account that did not
 *                finish (the callback failed while it retired the old connection). The
 *                page then asks for the sign-in again instead of showing success (#14).
 *   signedInAt:  when that account last signed in; the page uses it to tell a finished
 *                sign-in from the one it already knew. */
export async function googleStatus(deps: Deps, body: unknown): Promise<ApiResult> {
  const idToken = typeof body === 'object' && body !== null ? (body as { idToken?: unknown }).idToken : undefined
  const user = await requireLiffUser(deps, idToken)
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const account = await deps.store.findGoogleAccountByLineUser(user.lineUserId)
  if (!account) {
    return { status: 200, body: { connected: false, signInAgain: false, canChange: false, changePending: false, signedInAt: null } }
  }
  const connected = account.tokenStatus === 'valid'
  const projectIds = connected ? await deps.store.listConfirmedOwnerProjects(user.lineUserId) : []
  let changePending = false
  for (const projectId of projectIds) {
    const holder = (await deps.store.getDriveContext(projectId))?.activeAccountId ?? null
    if (holder !== null && holder !== account.id) {
      changePending = true
      break
    }
  }
  return {
    status: 200,
    body: {
      connected, signInAgain: !connected, canChange: projectIds.length > 0, changePending,
      signedInAt: account.signedInAt.toISOString(),
    },
  }
}
