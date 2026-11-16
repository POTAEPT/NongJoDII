import { type GroupPushResult, pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import { log } from '../log'
import type { Deps } from '../ports'
import { lineNameOf } from '../setup/load'
import { takeoverCard } from './card'

// #31 Project Owner change, step 1: the take-over question card. The change itself runs in
// the database: complete_owner_change (the #30 flow, setup/owner-change.ts, from the LIFF
// Owner page or the Google callback) calls change_project_owner under the main group's
// lock. That makes the person the Project's owner, confirms the main group, retires the old
// Drive connection and pauses on the take-over question (takeover_asked_at) the Sub groups
// still waiting or not running on the new Owner yet. onMainGroupOwnerChanged then calls
// askTakeoverQuestion after the response.
//
// One card in the main group (through the push budget) opens the take-over question (LIFF
// view 'takeover'). A LIFF page, not postback buttons: LINE does not always send the
// presser's userId on a group postback, and only the new Owner may answer. A card not sent
// (quota, LINE failure) is posted by the tick (takeover-retry.ts).

/** Share of the monthly quota the card leaves unspent: as small as the setup card's. */
export const TAKEOVER_PUSH_RESERVE = 0.02

export type TakeoverAsk = {
  waitingSubGroups: number
  card: GroupPushResult | 'none'
}

/** Posts the one take-over card in the main group when Sub groups wait on the question.
 *  `newOwnerLineUserId` names the Owner on the card; by default the Project's owner. Safe
 *  to repeat: the retry key is named by the database's ask time, so LINE drops a second
 *  push of the same question within 24 h. */
export async function askTakeoverQuestion(
  deps: Deps,
  p: { projectId: string; newOwnerLineUserId?: string },
): Promise<TakeoverAsk> {
  const after = await deps.store.getOwnerChange(p.projectId)
  const waiting = after?.waiting ?? []
  const mainGroup = after?.mainGroup ?? null
  let card: TakeoverAsk['card'] = 'none'
  if (after && waiting.length > 0 && mainGroup) {
    const ownerName = await lineNameOf(deps, p.newOwnerLineUserId ?? after.ownerLineUserId)
    card = await pushToGroupWithinBudget(deps, {
      purpose: 'owner_takeover', groupId: mainGroup.groupId, lineGroupId: mainGroup.lineGroupId,
      messages: [takeoverCard({ liffId: deps.config.liffId, mainGroupId: mainGroup.groupId, ownerName, subGroups: waiting.length })],
      reserve: TAKEOVER_PUSH_RESERVE,
      // One question per change: the database's ask time names it.
      retryKey: retryKeyFrom(`owner_takeover:${p.projectId}:${waiting[0].askedAt.toISOString()}`),
    })
  }
  log('project_owner_changed', { projectId: p.projectId, waitingSubGroups: waiting.length, card })
  return { waitingSubGroups: waiting.length, card }
}
