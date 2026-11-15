import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import { log } from '../log'
import type { Deps, TaskRow } from '../ports'
import type { Job } from '../webhook/ingest'
import { memberLeftCard } from './card'
import { postOwnerNeededCard } from './owner-left'

// #29 A member leaves a group (LINE memberLeft). The webhook ingest already saved the leave
// (webhook/ingest.ts): the person is marked as left, so they lose Dashboard and LIFF access
// to the group (ensureGroupAccess refuses a left Member) and cannot take Tasks there (#45),
// and their open Tasks went back to Not Assigned (Done Tasks keep their name for history).
// This job posts the one card listing those Tasks (one push, inside the push budget).
// A leave delivered twice posts once (webhook ledger); a second, separate leave event finds
// nothing left to release and posts nothing.
// #30: when the leaver was the group's Owner (job.ownerLeft, set at ingest, which also paused
// the Owner-backed features), the job also posts the one owner_needed card (owner-left.ts).

/** Share of the monthly quota this push leaves unspent: the same as the Tasks-created post. */
export const MEMBER_LEFT_PUSH_RESERVE = 0.1

export async function handleMemberLeft(
  deps: Deps,
  job: Extract<Job, { kind: 'member_left' }>,
): Promise<GroupPushResult | 'no_tasks'> {
  const { groupId, lineGroupId } = job
  if (job.ownerLeft) await postOwnerNeededCard(deps, { groupId, lineGroupId, ownerLineUserId: job.ownerLeft })
  // An Owner who held no open Tasks: no member-left card (it needs at least one Task).
  if (job.released.length === 0) return 'no_tasks'
  const released: TaskRow[] = job.released.flatMap((r) => r.tasks)
  const names: string[] = []
  for (const r of job.released) names.push((await deps.store.findLineUser(r.lineUserId))?.displayName ?? 'สมาชิก')
  log('member_left', { groupId, people: job.released.length, released: released.length })
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
