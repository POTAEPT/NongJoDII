import { log, logError } from '../log'
import type { ApiResult, Deps, TaskRow } from '../ports'
import { buildTaskFeedback } from './feedback'
import { badRequest, field, openSummary } from './load'
import type { NotifyResult } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TASKS = 10
/** Share of the monthly LINE quota kept back for pushes that matter more (reminders,
 *  Owner and member cards): a "Tasks created" push is skipped inside it. */
const QUOTA_RESERVE = 0.1

/** POST /api/review/notify. The LIFF page calls this only when it could not post the
 *  "Tasks created" message itself (liff.sendMessages is free; a push is not). The bot
 *  pushes it once per Task, and never inside the quota reserve. */
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
  // Only Tasks this requester just created from this Summary can be announced.
  const candidateIds = new Set((await deps.store.listCandidates(summary.id)).map((c) => c.id))
  const tasks: TaskRow[] = []
  for (const id of taskIds as string[]) {
    const t = await deps.store.getTask(id)
    if (!t || t.deletedAt !== null || t.groupId !== summary.groupId || t.candidateId === null ||
        !candidateIds.has(t.candidateId) || t.createdByLineUserId !== requester) {
      return badRequest('taskIds')
    }
    tasks.push(t)
  }

  const claimed = new Set(await deps.store.claimTaskAnnouncements(tasks.map((t) => t.id), deps.now()))
  const toAnnounce = tasks.filter((t) => claimed.has(t.id))
  if (toAnnounce.length === 0) return ok({ posted: false, reason: 'already_announced' })
  const release = () => deps.store.releaseTaskAnnouncements(toAnnounce.map((t) => t.id))

  try {
    const members = await deps.store.listLiveMembers(summary.groupId)
    // LINE counts a group push once per person in the group.
    const recipients = Math.max(members.length, 1)
    const quota = await deps.line.getMessageQuota()
    if (quota.limit !== null && quota.used + recipients > quota.limit * (1 - QUOTA_RESERVE)) {
      await release()
      log('task_feedback_skipped', { summaryId: summary.id, reason: 'quota' })
      return ok({ posted: false, reason: 'quota' })
    }
    const nameOf = new Map(members.map((m) => [m.lineUserId, m.displayName]))
    const text = buildTaskFeedback(toAnnounce.map((t) => ({
      title: t.title, assigned: t.assigneeLineUserId !== null,
      assigneeName: t.assigneeLineUserId ? (nameOf.get(t.assigneeLineUserId) ?? null) : null, dueAt: t.dueAt,
    })))
    await deps.line.push(summary.lineGroupId, [{ type: 'text', text }])
    try {
      await deps.store.recordPush({
        purpose: 'task_created', lineTargetId: summary.lineGroupId, messageCount: recipients, sentAt: deps.now(),
      })
    } catch (err) {
      // The push went out: keep the claim, so a retry never pushes it twice.
      logError('task_feedback_push_log_failed', { summaryId: summary.id }, err)
    }
    log('task_feedback_pushed', { summaryId: summary.id, tasks: toAnnounce.length })
    return ok({ posted: true })
  } catch (err) {
    logError('task_feedback_failed', { summaryId: summary.id }, err)
    await release().catch((e) => logError('task_feedback_release_failed', { summaryId: summary.id }, e))
    return { status: 502, body: { error: 'line_failed' } }
  }
}

function ok(result: NotifyResult): ApiResult {
  return { status: 200, body: result }
}
