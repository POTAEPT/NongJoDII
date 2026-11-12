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

/** A requester may act on a group only while they are a live Member. A person we
 *  have not seen yet is checked with LINE's group member profile API and added
 *  as a Member (source 'liff') when LINE says they are in the group. */
export async function ensureGroupAccess(
  deps: Deps,
  p: { groupId: string; lineGroupId: string; lineUserId: string },
): Promise<boolean> {
  const membership = await deps.store.getMembership(p.groupId, p.lineUserId)
  if (membership === 'live') return true
  if (membership === 'left') return false
  const profile = await deps.line.getGroupMemberProfile(p.lineGroupId, p.lineUserId)
  if (!profile) return false
  await deps.store.upsertLineUser({ lineUserId: p.lineUserId, displayName: profile.displayName })
  await deps.store.touchGroupMember(p.groupId, p.lineUserId, 'liff')
  return true
}
