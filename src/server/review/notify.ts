import { createHash } from 'node:crypto'
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
/** A page's reservation older than this counts as abandoned (the page closed). */
export const PENDING_ANNOUNCE_MS = 2 * 60_000

/** POST /api/review/notify. Each Task is announced once; announced_at, once set by a
 *  confirmed post or a push, is never cleared by a client.
 *  - 'claim' + claimToken: the LIFF page reserves Tasks before posting the message as
 *    the member (liff.sendMessages) and gets the text for the reserved Tasks only, so
 *    two open pages never both post. The page makes the token: a claim whose response
 *    was lost is retried with the same token and gets the same Tasks back.
 *  - 'confirm' + claimToken: the post went out; the reserved Tasks become announced.
 *  - 'push' (default), optional claimToken: the bot pushes. With the page's token it
 *    takes over that page's reservation (its post failed or its claim response was
 *    lost). It never spends the quota reserve, and a retry of the same Tasks reuses
 *    one LINE retry key, so LINE sends it once. */
export async function notifyReview(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSummary(deps, body)
  if (!gate.ok) return gate.result
  const { summary, requester } = gate

  const mode = field(body, 'mode') ?? 'push'
  if (mode !== 'push' && mode !== 'claim' && mode !== 'confirm') return badRequest('mode')
  const rawToken = field(body, 'claimToken')
  const claimToken = typeof rawToken === 'string' && UUID.test(rawToken) ? rawToken : null
  if (rawToken !== undefined && claimToken === null) return badRequest('claimToken')
  if (mode !== 'push' && claimToken === null) return badRequest('claimToken')
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
  const now = deps.now()
  const staleBefore = new Date(now.getTime() - PENDING_ANNOUNCE_MS)
  const ids = tasks.map((t) => t.id)
  if (mode === 'confirm') {
    await deps.store.confirmTaskAnnouncements(ids, claimToken as string, now)
    return ok({ posted: true })
  }
  const claimed = new Set(mode === 'claim'
    ? await deps.store.reserveTaskAnnouncements(ids, claimToken as string, now, staleBefore)
    : await deps.store.claimTaskAnnouncements(ids, now, { staleBefore, takeOverToken: claimToken }))
  const toAnnounce = tasks.filter((t) => claimed.has(t.id))
  if (toAnnounce.length === 0) return ok({ posted: false, reason: 'already_announced' })
  if (mode === 'claim') {
    let names = new Map<string, string | null>()
    try {
      names = new Map((await deps.store.listLiveMembers(summary.groupId)).map((m) => [m.lineUserId, m.displayName]))
    } catch (err) {
      logError('task_feedback_names_failed', { summaryId: summary.id }, err)
    }
    return ok({ claimed: true, text: feedbackText(toAnnounce, names), taskIds: toAnnounce.map((t) => t.id) })
  }
  const releaseTasks = () => deps.store.releaseTaskAnnouncements(toAnnounce.map((t) => t.id))

  let pushLogId: string | null = null
  try {
    const members = await deps.store.listLiveMembers(summary.groupId)
    // LINE counts a group push once per person in the group.
    const recipients = Math.max(members.length, 1)
    const quota = await deps.line.getMessageQuota()
    if (quota.limit !== null) {
      // Claimed under a lock with the pushes still in flight, so two announces
      // cannot both pass the check and together spend the reserve.
      ;({ pushLogId } = await deps.store.claimPushBudget({
        purpose: 'task_created', lineTargetId: summary.lineGroupId, messageCount: recipients,
        lineUsed: quota.used, allowed: Math.floor(quota.limit * (1 - QUOTA_RESERVE)),
      }))
      if (pushLogId === null) {
        await releaseTasks()
        log('task_feedback_skipped', { summaryId: summary.id, reason: 'quota' })
        return ok({ posted: false, reason: 'quota' })
      }
    } else {
      ;({ pushLogId } = await deps.store.claimPushBudget({
        purpose: 'task_created', lineTargetId: summary.lineGroupId, messageCount: recipients,
        lineUsed: 0, allowed: Number.MAX_SAFE_INTEGER,
      }))
    }
    const text = feedbackText(toAnnounce, new Map(members.map((m) => [m.lineUserId, m.displayName])))
    await deps.line.push(summary.lineGroupId, [{ type: 'text', text }], { retryKey: retryKeyFor(toAnnounce) })
    log('task_feedback_pushed', { summaryId: summary.id, tasks: toAnnounce.length })
    return ok({ posted: true })
  } catch (err) {
    // The push may still have reached LINE (a timeout). Releasing is safe: a retry of
    // the same Tasks sends the same retry key, and LINE answers 409 instead of
    // sending twice.
    logError('task_feedback_failed', { summaryId: summary.id }, err)
    if (pushLogId) {
      const id = pushLogId
      await deps.store.releasePushBudget(id).catch((e) => logError('task_feedback_budget_release_failed', { summaryId: summary.id }, e))
    }
    await releaseTasks().catch((e) => logError('task_feedback_release_failed', { summaryId: summary.id }, e))
    return { status: 502, body: { error: 'line_failed' } }
  }
}

/** One stable UUID per set of Tasks: the LINE retry key for announcing exactly them. */
export function retryKeyFor(tasks: { id: string }[]): string {
  const hex = createHash('sha256').update(tasks.map((t) => t.id).sort().join(',')).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
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
