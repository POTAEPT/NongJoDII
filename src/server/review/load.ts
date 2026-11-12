import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { ApiResult, Deps, SummaryRow } from '../ports'
import type { ReviewView } from './types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined
}

export function badRequest(f: string): ApiResult {
  return { status: 400, body: { error: 'bad_request', field: f } }
}

/** Shared gate of the review endpoints: verified LIFF user (401), UUID summaryId
 *  (400), existing Summary (404), live Member of its group (403). */
export async function openSummary(
  deps: Deps,
  body: unknown,
): Promise<{ ok: true; requester: string; summary: SummaryRow } | { ok: false; result: ApiResult }> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { ok: false, result: { status: 401, body: { error: 'unauthorized' } } }
  const summaryId = field(body, 'summaryId')
  if (typeof summaryId !== 'string' || !UUID.test(summaryId)) return { ok: false, result: badRequest('summaryId') }
  const summary = await deps.store.getSummary(summaryId)
  if (!summary) return { ok: false, result: { status: 404, body: { error: 'not_found' } } }
  const allowed = await ensureGroupAccess(deps, {
    groupId: summary.groupId, lineGroupId: summary.lineGroupId, lineUserId: user.lineUserId,
  })
  if (!allowed) return { ok: false, result: { status: 403, body: { error: 'forbidden' } } }
  return { ok: true, requester: user.lineUserId, summary }
}

const FALLBACK_NAME = 'สมาชิก LINE'

/** POST /api/review/load. The requester comes only from the verified LIFF ID token. */
export async function loadReview(deps: Deps, body: unknown): Promise<ApiResult> {
  const gate = await openSummary(deps, body)
  if (!gate.ok) return gate.result
  const { summary } = gate
  const [candidates, members] = await Promise.all([
    deps.store.listCandidates(summary.id),
    deps.store.listLiveMembers(summary.groupId),
  ])
  const view: ReviewView = {
    summaryId: summary.id,
    summaryText: summary.summaryText,
    candidates: candidates.map((c) => ({
      id: c.id, state: c.state, title: c.title, details: c.details,
      suggestedAssigneeLineUserId: c.suggestedAssigneeLineUserId,
      suggestedDueAt: c.suggestedDueAt ? c.suggestedDueAt.toISOString() : null,
    })),
    // LINE names only; nicknames never leave the AI prompt.
    members: members.map((m) => ({ lineUserId: m.lineUserId, displayName: m.displayName ?? FALLBACK_NAME })),
  }
  return { status: 200, body: view }
}
