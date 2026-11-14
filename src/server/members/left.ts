import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import { log } from '../log'
import type { Deps, TaskRow } from '../ports'
import type { Job } from '../webhook/ingest'
import { memberLeftCard } from './card'

// #29 A member leaves a group (LINE memberLeft):
//   - the person is marked as left, so they lose Dashboard and LIFF access to the group
//     (ensureGroupAccess refuses a left Member) and cannot take Tasks there (#45);
//   - their open Tasks go back to Not Assigned; Done Tasks keep their name for history;
//   - one card lists those Tasks in the group (one push, inside the push budget).
// A leave delivered twice runs once (webhook ledger); a second, separate leave event finds
// nothing left to release and posts nothing. The webhook's after() budget is enough: a few
// store calls and one push.

/** Share of the monthly quota this push leaves unspent: the same as the Tasks-created post. */
export const MEMBER_LEFT_PUSH_RESERVE = 0.1

export type MemberLeftResult = 'nothing_to_post' | GroupPushResult

export async function handleMemberLeft(
  deps: Deps,
  job: Extract<Job, { kind: 'member_left' }>,
): Promise<MemberLeftResult> {
  const { groupId, lineGroupId } = job
  const released: TaskRow[] = []
  const names: string[] = []
  for (const lineUserId of job.lineUserIds) {
    await deps.store.markMemberLeft({ groupId, lineUserId, at: job.at })
    const tasks = await deps.store.releaseTasksOf({ groupId, lineUserId })
    if (tasks.length === 0) continue
    released.push(...tasks)
    names.push((await deps.store.findLineUser(lineUserId))?.displayName ?? 'สมาชิก')
  }
  log('member_left', { groupId, people: job.lineUserIds.length, released: released.length })
  if (released.length === 0) return 'nothing_to_post'
  // Nearest due date first (no due date last), so the card's first bubbles are the most urgent.
  released.sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))

  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'member_left', groupId, lineGroupId,
    messages: [memberLeftCard({ names, tasks: released, liffId: deps.config.liffId })],
    reserve: MEMBER_LEFT_PUSH_RESERVE,
    retryKey: retryKeyFrom(`member_left:${job.eventId}`),
  })
  log('member_left_card', { groupId, result })
  return result
}
