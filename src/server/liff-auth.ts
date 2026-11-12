import type { Deps } from './ports'

/** The acting LINE user of a LIFF-facing endpoint. The ONLY source of requester
 *  identity: LINE verifies the ID token (signature, aud = LINE Login channel ID,
 *  exp). No request body field names the requester. Returns null when the token
 *  is missing, not a string, or rejected by LINE. */
export async function requireLiffUser(
  deps: Deps,
  idToken: unknown,
): Promise<{ lineUserId: string; displayName: string | null } | null> {
  if (typeof idToken !== 'string' || idToken === '') return null
  const user = await deps.line.verifyIdToken(idToken)
  if (!user) return null
  // Keeps line_users fresh and satisfies the FKs that reference it.
  await deps.store.upsertLineUser({ lineUserId: user.lineUserId, displayName: user.displayName })
  return user
}
