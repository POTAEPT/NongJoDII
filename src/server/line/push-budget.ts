import { createHash } from 'node:crypto'
import { log, logError } from '../log'
import type { Deps, PushPurpose } from '../ports'
import type { LineMessage } from './types'

// One push to a LINE group, inside the monthly LINE quota (#25 rule: near the limit the bot
// stops pushing and the item shows on the Dashboard only). Same counting as the Tasks-created
// announce (review/notify.ts): LINE counts a group push once per person in the group, so
// the cost is the larger of LINE's member count and the stored live Members. The budget is
// claimed under a database lock (claim_push_budget) before the push, and released if the
// push fails, or if LINE answers that it already accepted a push with the same retry key
// (nothing was sent this time).

export type GroupPushResult = 'pushed' | 'skipped_quota' | 'failed'

export type GroupPush = {
  purpose: PushPurpose
  groupId: string          // groups.id, for the stored Members
  lineGroupId: string      // LINE group ID the push goes to
  messages: LineMessage[]
  /** Share of the monthly quota this push must leave unspent (0.1 = stop at 90%). */
  reserve: number
  /** Same key for the same logical post: LINE then sends it once even if it is retried
   *  within 24 h (see retryKeyFrom). */
  retryKey: string
}

/** A stable UUID (the format LINE's X-Line-Retry-Key needs) from any text, e.g.
 *  `weekly_insight:<groupId>:<weekStart>`. */
export function retryKeyFrom(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Never throws: a LINE or database failure is logged and answered 'failed', so the caller
 *  can keep what it already saved (the item then shows on the Dashboard). */
export async function pushToGroupWithinBudget(deps: Deps, p: GroupPush): Promise<GroupPushResult> {
  let pushLogId: string | null = null
  try {
    const [members, lineCount, quota] = await Promise.all([
      deps.store.listLiveMembers(p.groupId),
      deps.line.getGroupMemberCount(p.lineGroupId),
      deps.line.getMessageQuota(),
    ])
    // The larger number errs toward skipping, never toward spending the reserve.
    const recipients = Math.max(lineCount, members.length, 1)
    ;({ pushLogId } = await deps.store.claimPushBudget({
      purpose: p.purpose, lineTargetId: p.lineGroupId, messageCount: recipients,
      lineUsed: quota.limit !== null ? quota.used : 0,
      allowed: quota.limit !== null ? Math.floor(quota.limit * (1 - p.reserve)) : Number.MAX_SAFE_INTEGER,
    }))
    if (pushLogId === null) {
      log('group_push_skipped', { purpose: p.purpose, groupId: p.groupId, reason: 'quota' })
      return 'skipped_quota'
    }
    const sent = await deps.line.push(p.lineGroupId, p.messages, { retryKey: p.retryKey })
    if (sent === 'duplicate') {
      // LINE had already accepted this post (same retry key) and sent nothing now. The post
      // is in the group, so it counts as pushed, but this claim books messages that were
      // never sent: give it back. The accepted push keeps its own claim.
      log('group_push_duplicate', { purpose: p.purpose, groupId: p.groupId })
      await deps.store.releasePushBudget(pushLogId)
        .catch((e) => logError('group_push_budget_release_failed', { purpose: p.purpose, groupId: p.groupId }, e))
    }
    return 'pushed'
  } catch (err) {
    logError('group_push_failed', { purpose: p.purpose, groupId: p.groupId }, err)
    if (pushLogId !== null) {
      // The push may still have reached LINE (a timeout); LINE's own count catches up, and
      // a retry with the same key is not sent twice.
      await deps.store.releasePushBudget(pushLogId)
        .catch((e) => logError('group_push_budget_release_failed', { purpose: p.purpose, groupId: p.groupId }, e))
    }
    return 'failed'
  }
}
