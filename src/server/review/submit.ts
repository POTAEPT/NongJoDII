import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { statusFor, type TaskFields, validateTaskFields } from '../tasks/fields'
import { badRequest, field, openSummary } from './load'
import type { SubmitResult } from './types'

const MAX_DECISIONS = 10

type Planned =
  | { candidateId: string; action: 'decline' }
  | { candidateId: string; action: 'confirm'; fields: TaskFields }

/** POST /api/review/submit. Confirms (with edits) or declines several candidates.
 *  Everything is validated before anything is written. A confirm locks the
 *  candidate, creates its Task and marks it confirmed in one transaction, so a
 *  decline that won the race is respected and a retry never duplicates
 *  (tasks.candidate_id is unique). */
export async function submitReview(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSummary(deps, body)
  if (!gate.ok) return gate.result
  const { summary, requester } = gate

  const decisions = field(body, 'decisions')
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > MAX_DECISIONS) {
    return badRequest('decisions')
  }
  const candidates = new Map((await deps.store.listCandidates(summary.id)).map((c) => [c.id, c]))
  const seen = new Set<string>()
  const plan: Planned[] = []
  for (const d of decisions) {
    const candidateId = field(d, 'candidateId')
    if (typeof candidateId !== 'string' || seen.has(candidateId)) return badRequest('candidateId')
    const candidate = candidates.get(candidateId)
    if (!candidate) return badRequest('candidateId')
    seen.add(candidateId)
    const action = field(d, 'action')
    if (action === 'decline') {
      plan.push({ candidateId, action })
    } else if (action === 'confirm') {
      const v = await validateTaskFields(deps.store, summary.groupId, {
        title: field(d, 'title'), details: field(d, 'details'),
        assigneeLineUserId: field(d, 'assigneeLineUserId'), dueAt: field(d, 'dueAt'),
      })
      if (!v.ok) return badRequest(v.field)
      plan.push({ candidateId, action, fields: v.fields })
    } else {
      return badRequest('action')
    }
  }

  const now = deps.now()
  const results: SubmitResult['results'] = []
  for (const p of plan) {
    if (p.action === 'decline') {
      // D30: a decline is final; only a proposed candidate can be declined.
      const { updated } = await deps.store.decideCandidate(p.candidateId, 'declined', requester, now)
      results.push({ candidateId: p.candidateId, outcome: updated ? 'declined' : 'already_decided' })
      continue
    }
    // The candidate state read above may be stale: the store re-reads it under a lock.
    // L3: a proposed candidate is marked confirmed even when its Task already existed.
    const { outcome, taskId } = await deps.store.confirmCandidate({
      groupId: summary.groupId, candidateId: p.candidateId, ...p.fields,
      status: statusFor(p.fields.assigneeLineUserId, null), createdByLineUserId: requester,
    }, now)
    results.push(taskId ? { candidateId: p.candidateId, outcome, taskId } : { candidateId: p.candidateId, outcome })
  }
  log('review_submitted', {
    summaryId: summary.id,
    created: results.filter((r) => r.outcome === 'created').length,
    declined: results.filter((r) => r.outcome === 'declined').length,
  })
  const result: SubmitResult = { results }
  return { status: 200, body: result }
}
