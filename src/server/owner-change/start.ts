import { type GroupPushResult, pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log } from '../log'
import type { Deps } from '../ports'
import { lineNameOf } from '../setup/load'
import { takeoverCard } from './card'

// #31 Project Owner change, step 1. Called once a new Owner has confirmed with LINE login
// for a Project's main group (the #30 flow). change_project_owner does the confirm itself:
// it makes the person the Project's owner, confirms the main group, retires the old Drive
// connection and pauses every Sub group on the take-over question (takeover_asked_at). So
// for a main group that is already in a Project, the #30 confirm calls this instead of
// confirmGroupOwner (which answers 'closed' once a Project exists).
//
// Then one card in the main group (through the push budget) opens the take-over question
// (LIFF view 'takeover'). A LIFF page, not postback buttons: LINE does not always send the
// presser's userId on a group postback, and only the new Owner may answer.

/** Share of the monthly quota the card leaves unspent: as small as the setup card's, as it
 *  is sent once and nothing repeats it (the question also waits in the LIFF view). */
export const TAKEOVER_PUSH_RESERVE = 0.02

export type OwnerChangeStart = {
  /** already_owner: this person is already the Project's confirmed owner (a repeated
   *  confirm); nothing changed, so the 7-day count does not restart. */
  outcome: 'changed' | 'already_owner' | 'not_nominee' | 'no_project'
  waitingSubGroups: number
  card: GroupPushResult | 'none'
}

export async function startProjectOwnerChange(
  deps: Deps,
  p: { projectId: string; newOwnerLineUserId: string; now: Date },
): Promise<OwnerChangeStart> {
  const { store } = deps
  const before = await store.getOwnerChange(p.projectId)
  if (!before) return { outcome: 'no_project', waitingSubGroups: 0, card: 'none' }
  const main = before.mainGroup
  // change_project_owner run again would pause Sub groups already taken over and restart
  // the 7 days, so a repeat stops here.
  if (before.ownerLineUserId === p.newOwnerLineUserId && main?.nominatedOwnerLineUserId === p.newOwnerLineUserId &&
    main.ownerConfirmedAt !== null) {
    return { outcome: 'already_owner', waitingSubGroups: before.waiting.length, card: 'none' }
  }
  const { outcome } = await store.changeProjectOwner(p.projectId, p.newOwnerLineUserId)
  if (outcome === 'not_nominee') return { outcome, waitingSubGroups: 0, card: 'none' }

  const after = await store.getOwnerChange(p.projectId)
  const waiting = after?.waiting ?? []
  const mainGroup = after?.mainGroup ?? null
  let card: OwnerChangeStart['card'] = 'none'
  if (waiting.length > 0 && mainGroup) {
    const ownerName = await lineNameOf(deps, p.newOwnerLineUserId)
    card = await pushToGroupWithinBudget(deps, {
      purpose: 'owner_takeover', groupId: mainGroup.groupId, lineGroupId: mainGroup.lineGroupId,
      messages: [takeoverCard({ liffId: deps.config.liffId, mainGroupId: mainGroup.groupId, ownerName, subGroups: waiting.length })],
      reserve: TAKEOVER_PUSH_RESERVE,
      // One question per change: the database's ask time names it.
      retryKey: retryKeyFrom(`owner_takeover:${p.projectId}:${waiting[0].askedAt.toISOString()}`),
    })
  }
  log('project_owner_changed', { projectId: p.projectId, waitingSubGroups: waiting.length, card })
  return { outcome: 'changed', waitingSubGroups: waiting.length, card }
}
