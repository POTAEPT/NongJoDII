import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { badRequest, field } from '../review/load'
import { FALLBACK_NAME, openSetupGroup } from '../setup/load'
import { cleanNicknames, NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX, ROLE_MAX } from '../setup/rules'

// #29 "my info": a Member sets their own nicknames and role in one group, opened from the
// welcome reply to a join. Only the requester's own row is read or written: the person
// comes from the verified LIFF ID token, never from the body. The Owner edits everyone's
// in Settings (#28). Nicknames help the AI tell who a chat message is about; every screen
// still shows LINE names.

export type MyProfile = {
  groupId: string; groupName: string | null; displayName: string; nicknames: string[]; role: string | null
}

/** POST /api/me/load */
export async function loadMyProfile(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  const me = (await deps.store.listLiveMembers(group.groupId)).find((m) => m.lineUserId === requester)
  // The gate just saw them live: a leave landed in between.
  if (!me) return { status: 403, body: { error: 'forbidden' } }
  const view: MyProfile = {
    groupId: group.groupId, groupName: group.name, displayName: me.displayName ?? FALLBACK_NAME,
    nicknames: me.nicknames, role: me.role,
  }
  return { status: 200, body: view }
}

/** POST /api/me/save { idToken, groupId, nicknames: string[], role: string } */
export async function saveMyProfile(deps: Deps, body: unknown): Promise<ApiResult> {
  const rawNicknames = field(body, 'nicknames')
  if (!Array.isArray(rawNicknames) || !rawNicknames.every((n) => typeof n === 'string')) return badRequest('nicknames')
  const nicknames = cleanNicknames(rawNicknames as string[])
  if (nicknames.length > NICKNAMES_PER_MEMBER_MAX || nicknames.some((n) => n.length > NICKNAME_MAX)) {
    return badRequest('nicknames')
  }
  const rawRole = field(body, 'role')
  if (typeof rawRole !== 'string' || rawRole.trim().length > ROLE_MAX) return badRequest('role')
  const role = rawRole.trim() === '' ? null : rawRole.trim()

  const gate = await openSetupGroup(deps, body)
  if (!gate.ok) return gate.result
  const { group, requester } = gate
  const { updated } = await deps.store.setMemberProfile({ groupId: group.groupId, lineUserId: requester, nicknames, role })
  if (!updated) return { status: 403, body: { error: 'forbidden' } }
  log('member_profile_saved', { groupId: group.groupId })
  return { status: 200, body: { nicknames, role } }
}
