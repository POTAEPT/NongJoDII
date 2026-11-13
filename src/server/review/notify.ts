import { randomUUID } from 'node:crypto'
import { log, logError } from '../log'
import type { ApiResult, Deps, TaskRow } from '../ports'
import { buildTaskFeedback } from './feedback'
import { badRequest, field, openSummary } from './load'
import type { NotifyResult } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TASKS = 10
/** Share of the monthly LINE quota kept back for pushes that matter more (reminders,
 *  Owner and member cards): a "Tasks created" push is skipped inside it. Agent choice. */
const QUOTA_RESERVE = 0.1
/** A claim older than this belongs to a dead request and may be taken over. Longer
 *  than the route's maxDuration (60 s), so a live request's claim is never taken over;
 *  a take-over of a dead one keeps the token (the retry key), so LINE still sends once. */
const ANNOUNCE_STALE_MS = 2 * 60_000

/** POST /api/review/notify. The bot pushes the "Tasks created" message to the
 *  Summary's group. Tasks are claimed with a pending token, and announced_at is set
 *  only after LINE accepts. Each claim batch is one push whose LINE retry key is its
 *  token: a failed or abandoned batch is retried whole with the same key, never merged
 *  with new Tasks, so LINE delivers each batch once. The push never spends the quota
 *  reserve. */
export async function notifyReview(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSummary(deps, body)
  if (!gate.ok) return gate.result
  const { summary, requester } = gate

  const taskIds = field(body, 'taskIds')
  if (
    !Array.isArray(taskIds) || taskIds.length === 0 || taskIds.length > MAX_TASKS ||
    !taskIds.every((id) => typeof id === 'string' && UUID.test(id)) || new Set(taskIds).size !== taskIds.length
  ) {
    return badRequest('taskIds')
  }
  // Every Task must come from this Summary. Only the requester's own live Tasks are
  // announced; others are skipped, so the page can send every Task ID its submit
  // returned (a retry after a lost response sees them as already_decided).
  const candidateIds = new Set((await deps.store.listCandidates(summary.id)).map((c) => c.id))
  const tasks: TaskRow[] = []
  for (const id of taskIds as string[]) {
    const t = await deps.store.getTask(id)
    if (!t || t.groupId !== summary.groupId || t.candidateId === null || !candidateIds.has(t.candidateId)) {
      return badRequest('taskIds')
    }
    if (t.deletedAt === null && t.createdByLineUserId === requester) tasks.push(t)
  }
  if (tasks.length === 0) return ok({ posted: false, reason: 'nothing_to_announce' })
  const token = randomUUID()
  const now = deps.now()
  // Batches not yet pushed. A re-claimed batch may have reached LINE before, so it is
  // released with its token kept (same retry key next time). The fresh batch was
  // never pushed under its token, so it drops the token and its Tasks are claimed
  // fresh next time, together with any newer ones.
  const pending: Batch[] = []
  const free = (b: Batch) => b.token === token
    ? deps.store.abandonTaskAnnouncements(b.token, now)
        .catch((e) => logError('task_feedback_abandon_failed', { summaryId: summary.id }, e))
    : deps.store.releaseTaskAnnouncements(b.token, now)
        .catch((e) => logError('task_feedback_release_failed', { summaryId: summary.id }, e))
  const releaseRest = async () => {
    for (const b of pending.splice(0)) await free(b)
  }
  let posted = 0
  let skipped = false
  // Requested Tasks this call holds; any other unannounced one is held elsewhere.
  let held = new Set<string>()
  try {
    let claimed: { taskId: string; token: string }[]
    try {
      claimed = await deps.store.claimTaskAnnouncements({
        taskIds: tasks.map((t) => t.id), token, at: now, staleBefore: new Date(now.getTime() - ANNOUNCE_STALE_MS),
      })
    } catch (err) {
      // The fresh update may have committed before the answer was lost. Re-claimed
      // batches are unknown here; they go stale and recover with their own token.
      logError('task_feedback_claim_failed', { summaryId: summary.id }, err)
      await free({ token, taskIds: [] })
      return { status: 502, body: { error: 'line_failed' } }
    }
    if (claimed.length === 0) {
      if (tasks.every((t) => t.announcedAt !== null)) return ok({ posted: false, reason: 'already_announced' })
      // Another live request holds the claim. Not a 200: the page would show it as posted.
      return { status: 409, body: { error: 'announce_in_progress' } }
    }
    held = new Set(claimed.map((c) => c.taskId))
    pending.push(...batchesOf(claimed, tasks.map((t) => t.id), token))

    const known = new Map(tasks.map((t) => [t.id, t]))
    for (const b of pending) {
      for (const id of b.taskIds) {
        if (known.has(id)) continue
        // A row of a re-claimed batch this request did not name.
        const t = await deps.store.getTask(id)
        if (t && t.deletedAt === null) known.set(id, t)
      }
    }
    const members = await deps.store.listLiveMembers(summary.groupId)
    // LINE counts a group push once per person in the group. Its count includes
    // members the bot never stored (silent ones); the stored list can still hold
    // someone who left without a leave event. The larger number errs toward
    // skipping, never toward spending the reserve.
    const lineCount = await deps.line.getGroupMemberCount(summary.lineGroupId)
    const recipients = Math.max(lineCount, members.length, 1)
    const quota = await deps.line.getMessageQuota()
    const names = new Map(members.map((m) => [m.lineUserId, m.displayName]))

    while (pending.length > 0) {
      const batch = pending[0]
      const rows = batch.taskIds.flatMap((id) => known.get(id) ?? [])
      if (rows.length === 0) {
        // Every row was deleted after the claim: nothing to announce, never an empty push.
        pending.shift()
        await deps.store.confirmTaskAnnouncements(batch.token, now)
          .catch((e) => logError('task_feedback_confirm_failed', { summaryId: summary.id }, e))
        continue
      }
      // Claimed under a lock with the pushes still in flight, so two announces
      // cannot both pass the check and together spend the reserve.
      const { pushLogId } = await deps.store.claimPushBudget({
        purpose: 'task_created', lineTargetId: summary.lineGroupId, messageCount: recipients,
        lineUsed: quota.limit !== null ? quota.used : 0,
        allowed: quota.limit !== null ? Math.floor(quota.limit * (1 - QUOTA_RESERVE)) : Number.MAX_SAFE_INTEGER,
      })
      if (pushLogId === null) {
        skipped = true
        await releaseRest()
        log('task_feedback_skipped', { summaryId: summary.id, reason: 'quota' })
        break
      }
      pending.shift()
      try {
        await deps.line.push(summary.lineGroupId, [{ type: 'text', text: feedbackText(rows, names) }], { retryKey: batch.token })
      } catch (err) {
        // The push may still have reached LINE (a timeout). Releasing keeps the token,
        // so the retry sends the same retry key and LINE answers 409 instead of sending twice.
        logError('task_feedback_failed', { summaryId: summary.id }, err)
        await deps.store.releasePushBudget(pushLogId)
          .catch((e) => logError('task_feedback_budget_release_failed', { summaryId: summary.id }, e))
        await deps.store.releaseTaskAnnouncements(batch.token, now)
          .catch((e) => logError('task_feedback_release_failed', { summaryId: summary.id }, e))
        await releaseRest()
        return { status: 502, body: { error: 'line_failed' } }
      }
      posted++
      log('task_feedback_pushed', { summaryId: summary.id, tasks: rows.length })
      try {
        await deps.store.confirmTaskAnnouncements(batch.token, now)
      } catch (err) {
        // LINE has the push. The claim goes stale and the next claim resends it with
        // the same key: LINE answers 409, then the confirm runs again.
        logError('task_feedback_confirm_failed', { summaryId: summary.id }, err)
      }
    }
  } catch (err) {
    logError('task_feedback_failed', { summaryId: summary.id }, err)
    await releaseRest()
    return { status: 502, body: { error: 'line_failed' } }
  }
  // A skipped batch means some Tasks were not announced: report quota even if an
  // earlier batch went out, so the page does not show them as posted.
  if (skipped) return ok({ posted: false, reason: 'quota' })
  // Another live request holds some of these Tasks and may still fail: not a 200, so
  // the page keeps its retry. A Task announced before this call is not missing.
  if (tasks.some((t) => t.announcedAt === null && !held.has(t.id))) {
    return { status: 409, body: { error: 'announce_in_progress' } }
  }
  return ok(posted > 0 ? { posted: true } : { posted: false, reason: 'nothing_to_announce' })
}

type Batch = { token: string; taskIds: string[] }

/** Groups the claimed rows by token. Re-claimed batches go first (in the order the
 *  request names them), the fresh batch last; inside a batch the request's order
 *  comes first, then a re-claimed batch's other rows. */
function batchesOf(claimed: { taskId: string; token: string }[], requested: string[], fresh: string): Batch[] {
  const rank = (id: string) => {
    const i = requested.indexOf(id)
    return i === -1 ? requested.length : i
  }
  const byToken = new Map<string, string[]>()
  for (const c of [...claimed].sort((a, b) => rank(a.taskId) - rank(b.taskId))) {
    byToken.set(c.token, [...(byToken.get(c.token) ?? []), c.taskId])
  }
  const batches = [...byToken].map(([token, taskIds]) => ({ token, taskIds }))
  return [...batches.filter((b) => b.token !== fresh), ...batches.filter((b) => b.token === fresh)]
}

function feedbackText(tasks: TaskRow[], names: Map<string, string | null>): string {
  return buildTaskFeedback(tasks.map((t) => ({
    title: t.title, assigned: t.assigneeLineUserId !== null,
    assigneeName: t.assigneeLineUserId ? (names.get(t.assigneeLineUserId) ?? null) : null, dueAt: t.dueAt,
  })))
}

function ok(result: NotifyResult): ApiResult {
  return { status: 200, body: result }
}
