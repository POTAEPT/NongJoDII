import { log } from '../log'
import type { ApiResult, CandidateState, Deps } from '../ports'
import { statusFor, type TaskFields, validateTaskFields } from '../tasks/fields'
import { badRequest, field, openSummary } from './load'
import type { SubmitResult } from './types'

const MAX_DECISIONS = 10

type Planned =
  | { candidateId: string; state: CandidateState; action: 'decline' }
  | { candidateId: string; state: CandidateState; action: 'confirm'; fields: TaskFields }

/** POST /api/review/submit. Confirms (with edits) or declines several candidates.
 *  Everything is validated before anything is written. A Task is created first,
 *  then its candidate is marked confirmed, so a retry after a crash in between
 *  heals instead of duplicating (tasks.candidate_id is unique). */
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
      plan.push({ candidateId, state: candidate.state, action })
    } else if (action === 'confirm') {
      const v = await validateTaskFields(deps.store, summary.groupId, {
        title: field(d, 'title'), details: field(d, 'details'),
        assigneeLineUserId: field(d, 'assigneeLineUserId'), dueAt: field(d, 'dueAt'),
      })
      if (!v.ok) return badRequest(v.field)
      plan.push({ candidateId, state: candidate.state, action, fields: v.fields })
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
    if (p.state === 'declined') {
      results.push({ candidateId: p.candidateId, outcome: 'already_decided' })
      continue
    }
    const { created, taskId } = await deps.store.createTask({
      groupId: summary.groupId, candidateId: p.candidateId, ...p.fields,
      status: statusFor(p.fields.assigneeLineUserId, null), createdByLineUserId: requester,
    })
    // L3: always mark a proposed candidate confirmed, even when its Task already existed.
    if (p.state === 'proposed') await deps.store.decideCandidate(p.candidateId, 'confirmed', requester, now)
    results.push({ candidateId: p.candidateId, outcome: created ? 'created' : 'already_decided', taskId })
  }
  log('review_submitted', {
    summaryId: summary.id,
    created: results.filter((r) => r.outcome === 'created').length,
    declined: results.filter((r) => r.outcome === 'declined').length,
  })
  const result: SubmitResult = { results }
  return { status: 200, body: result }
}
