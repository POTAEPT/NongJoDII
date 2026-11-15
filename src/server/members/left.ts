import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import { log } from '../log'
import type { Deps, TaskRow } from '../ports'
import type { Job } from '../webhook/ingest'
import { memberLeftCard } from './card'

// #29 A member leaves a group (LINE memberLeft). The webhook ingest already saved the leave
// (webhook/ingest.ts): the person is marked as left, so they lose Dashboard and LIFF access
// to the group (ensureGroupAccess refuses a left Member) and cannot take Tasks there (#45),
// and their open Tasks went back to Not Assigned (Done Tasks keep their name for history).
// This job posts the one card listing those Tasks (one push, inside the push budget).
// A leave delivered twice posts once (webhook ledger); a second, separate leave event finds
// nothing left to release and posts nothing.

/** Share of the monthly quota this push leaves unspent: the same as the Tasks-created post. */
export const MEMBER_LEFT_PUSH_RESERVE = 0.1

export async function handleMemberLeft(
  deps: Deps,
  job: Extract<Job, { kind: 'member_left' }>,
): Promise<GroupPushResult> {
  const { groupId, lineGroupId } = job
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

/** The leave's writes, shared by the memberLeft webhook (webhook/ingest.ts) and the daily
 *  member check (#32, members/daily-check.ts). For each person: the LINE user row (the
 *  group_members FK), the leave mark at `at`, then the release of their open Tasks. Returns
 *  the people whose Tasks were released, with those Tasks, for handleMemberLeft's card.
 *  Every write is idempotent, so a repeat releases nothing and makes no card. */
export async function recordMemberLeft(
  deps: Deps,
  p: { groupId: string; lineUserIds: string[]; at: Date },
): Promise<{ lineUserId: string; tasks: TaskRow[] }[]> {
  const released: { lineUserId: string; tasks: TaskRow[] }[] = []
  for (const lineUserId of p.lineUserIds) {
    await deps.store.upsertLineUser({ lineUserId, displayName: null })
    await deps.store.markMemberLeft({ groupId: p.groupId, lineUserId, at: p.at })
    // A leave older than a rejoin already applied changed nothing: the person is a current
    // Member, so the release finds them live and keeps their Tasks. It checks and releases
    // in one database step, so a newer join cannot slip between the two; and it does not
    // trust `updated`, so a redelivery after the write but before the release still releases.
    const tasks = await deps.store.releaseTasksIfLeft({ groupId: p.groupId, lineUserId })
    if (tasks.length > 0) released.push({ lineUserId, tasks })
  }
  return released
}
