import type { SupabaseClient } from '@supabase/supabase-js'
import { AdapterError } from '../log'
import type {
  AiUsageActual,
  AiUsageCap,
  CandidateRow,
  GroupRow,
  Member,
  Membership,
  MessageRef,
  NewAiUsage,
  NewCandidate,
  NewGoogleAccount,
  NewMessage,
  NewProgressPrompt,
  NewSummary,
  NewTask,
  NewWebhookEvent,
  ProgressAnswer,
  ProgressPromptRow,
  StorePort,
  StoredMessage,
  SummaryRow,
  TaskPatch,
  TaskRow,
  ProgressYes,
  ProgressYesOutcome,
} from '../ports'
import {
  type DbCandidate,
  type DbGroup,
  type DbMember,
  type DbMessage,
  type DbTask,
  toCandidateRow,
  toDate,
  toGroupRow,
  toMember,
  toStoredMessage,
  toTaskRow,
} from './mappers'

// StorePort on Supabase (PostgREST, secret key, server only). Tables and columns
// are those of supabase/migrations/. Store-once writes are
// upsert(row, { onConflict, ignoreDuplicates: true }).select(<key>), i.e.
// INSERT ... ON CONFLICT (<target>) DO NOTHING RETURNING: the returned rows are
// only the rows actually inserted, so an empty array means duplicate.
// Errors throw AdapterError with the Postgres/PostgREST code only (messages may echo data).

const GROUP_COLS =
  'id, line_group_id, project_id, name, nominated_owner_line_user_id, owner_confirmed_at, feature_summarize, feature_draft_tasks, work_description, feature_track_remind'
const CANDIDATE_COLS =
  'id, summary_id, state, title, details, suggested_assignee_line_user_id, suggested_due_at'
const TASK_COLS =
  'id, group_id, candidate_id, title, details, status, assignee_line_user_id, created_by_line_user_id, due_at, deleted_at, groups(line_group_id)'
const PROMPT_COLS =
  'id, group_id, task_id, target_status, subject_line_user_id, trigger_message_id, asked_at, answer, answered_by_line_user_id, answered_at'

type DbPrompt = {
  id: string; group_id: string; task_id: string; target_status: 'in_process' | 'done'
  subject_line_user_id: string | null; trigger_message_id: string | null; asked_at: string
  answer: ProgressAnswer | null; answered_by_line_user_id: string | null; answered_at: string | null
}

function toPromptRow(r: DbPrompt): ProgressPromptRow {
  return {
    id: r.id, groupId: r.group_id, taskId: r.task_id, targetStatus: r.target_status,
    subjectLineUserId: r.subject_line_user_id, triggerMessageId: r.trigger_message_id, askedAt: toDate(r.asked_at),
    answer: r.answer, answeredByLineUserId: r.answered_by_line_user_id, answeredAt: toDate(r.answered_at),
  }
}

type PgError = { code: string } | null

function check(method: keyof StorePort, error: PgError): void {
  if (error) throw new AdapterError(`supabase ${method}: ${error.code}`)
}

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString()
}

export class SupabaseStore implements StorePort {
  constructor(private readonly db: SupabaseClient) {}

  // ---- #1 webhook ----
  async recordWebhookEvent(e: NewWebhookEvent): Promise<{ inserted: boolean }> {
    const { data, error } = await this.db
      .from('webhook_events')
      .upsert(
        {
          webhook_event_id: e.webhookEventId, event_type: e.eventType, line_group_id: e.lineGroupId,
          event_timestamp: e.eventTimestamp.toISOString(), is_redelivery: e.isRedelivery,
        },
        { onConflict: 'webhook_event_id', ignoreDuplicates: true },
      )
      .select('webhook_event_id')
    check('recordWebhookEvent', error)
    return { inserted: (data ?? []).length === 1 }
  }

  async upsertLineUser(u: { lineUserId: string; displayName: string | null }): Promise<void> {
    // A null name only makes sure the row exists; it never overwrites a known name.
    const { error } =
      u.displayName === null
        ? await this.db
            .from('line_users')
            .upsert({ line_user_id: u.lineUserId }, { onConflict: 'line_user_id', ignoreDuplicates: true })
        : await this.db
            .from('line_users')
            .upsert({ line_user_id: u.lineUserId, display_name: u.displayName }, { onConflict: 'line_user_id' })
    check('upsertLineUser', error)
  }

  async findLineUser(lineUserId: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    const { data, error } = await this.db
      .from('line_users')
      .select('line_user_id, display_name')
      .eq('line_user_id', lineUserId)
      .maybeSingle()
    check('findLineUser', error)
    const row = data as { line_user_id: string; display_name: string | null } | null
    return row ? { lineUserId: row.line_user_id, displayName: row.display_name } : null
  }

  async ensureGroup(lineGroupId: string): Promise<GroupRow> {
    const ins = await this.db
      .from('groups')
      .upsert({ line_group_id: lineGroupId }, { onConflict: 'line_group_id', ignoreDuplicates: true })
    check('ensureGroup', ins.error)
    const { data, error } = await this.db.from('groups').select(GROUP_COLS).eq('line_group_id', lineGroupId).single()
    check('ensureGroup', error)
    return toGroupRow(data as DbGroup)
  }

  async getGroupById(groupId: string): Promise<GroupRow | null> {
    const { data, error } = await this.db.from('groups').select(GROUP_COLS).eq('id', groupId).maybeSingle()
    check('getGroupById', error)
    return data ? toGroupRow(data as DbGroup) : null
  }

  async touchGroupMember(groupId: string, lineUserId: string, source: 'message' | 'liff'): Promise<void> {
    // Insert-if-absent: never overwrites source or left_at of an existing row.
    const { error } = await this.db
      .from('group_members')
      .upsert(
        { group_id: groupId, line_user_id: lineUserId, source },
        { onConflict: 'group_id,line_user_id', ignoreDuplicates: true },
      )
    check('touchGroupMember', error)
  }

  async getMembership(groupId: string, lineUserId: string): Promise<Membership> {
    const { data, error } = await this.db
      .from('group_members')
      .select('left_at')
      .eq('group_id', groupId)
      .eq('line_user_id', lineUserId)
      .maybeSingle()
    check('getMembership', error)
    const row = data as { left_at: string | null } | null
    if (!row) return 'none'
    return row.left_at === null ? 'live' : 'left'
  }

  async insertMessage(m: NewMessage): Promise<{ inserted: boolean; id: string | null }> {
    // A redelivery repeats webhook_event_id (and line_message_id), so this target
    // catches it. A clash on line_message_id alone is outside the target and throws.
    const { data, error } = await this.db
      .from('messages')
      .upsert(
        {
          group_id: m.groupId, webhook_event_id: m.webhookEventId, line_message_id: m.lineMessageId,
          sender_line_user_id: m.senderLineUserId, message_type: m.messageType, text: m.text,
          sent_at: m.sentAt.toISOString(), image_set_id: m.imageSetId, image_set_index: m.imageSetIndex,
          image_set_total: m.imageSetTotal, mentions: m.mentions,
        },
        { onConflict: 'webhook_event_id', ignoreDuplicates: true },
      )
      .select('id')
    check('insertMessage', error)
    const rows = (data ?? []) as { id: string }[]
    return rows.length === 1 ? { inserted: true, id: rows[0].id } : { inserted: false, id: null }
  }

  // ---- #15 Summary ----
  async listRecentTextMessages(groupId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from('messages')
      .select('id, sender_line_user_id, text, sent_at, mentions, line_users(display_name)')
      .eq('group_id', groupId)
      .eq('message_type', 'text')
      .not('text', 'is', null)
      .order('sent_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit)
    check('listRecentTextMessages', error)
    return ((data ?? []) as unknown as DbMessage[]).map(toStoredMessage).reverse()
  }

  async listLiveMembers(groupId: string): Promise<Member[]> {
    const { data, error } = await this.db
      .from('group_members')
      .select('line_user_id, nicknames, role, line_users(display_name)')
      .eq('group_id', groupId)
      .is('left_at', null)
    check('listLiveMembers', error)
    return ((data ?? []) as unknown as DbMember[]).map(toMember)
  }

  /** Two statements (not one transaction): a failed candidate insert leaves the Summary row. */
  async createSummary(s: NewSummary, candidates: NewCandidate[]): Promise<{ summaryId: string; candidateIds: string[] }> {
    const sum = await this.db
      .from('summaries')
      .insert({
        group_id: s.groupId, requested_by_line_user_id: s.requestedByLineUserId, summary_text: s.summaryText,
        first_message_at: iso(s.firstMessageAt), last_message_at: iso(s.lastMessageAt),
        created_at: s.createdAt.toISOString(),
      })
      .select('id')
      .single()
    check('createSummary', sum.error)
    const summaryId = (sum.data as { id: string }).id
    if (candidates.length === 0) return { summaryId, candidateIds: [] }

    // Candidate i gets created_at = createdAt + i ms (M2): one statement would give
    // every row the same now(), and order by created_at, id would fall to UUID order.
    const base = s.createdAt.getTime()
    const { data, error } = await this.db
      .from('task_candidates')
      .insert(
        candidates.map((c, i) => ({
          summary_id: summaryId, title: c.title, details: c.details,
          suggested_assignee_line_user_id: c.suggestedAssigneeLineUserId,
          suggested_due_at: iso(c.suggestedDueAt), created_at: new Date(base + i).toISOString(),
        })),
      )
      .select('id, created_at')
    check('createSummary', error)
    // Return order is not guaranteed: map rows back to input order by their created_at offset.
    const ids: (string | undefined)[] = candidates.map(() => undefined)
    for (const row of (data ?? []) as { id: string; created_at: string }[]) {
      const i = new Date(row.created_at).getTime() - base
      if (i >= 0 && i < ids.length) ids[i] = row.id
    }
    if (ids.some((id) => id === undefined)) throw new AdapterError('supabase createSummary: candidate_ids')
    return { summaryId, candidateIds: ids as string[] }
  }

  // ---- #16 confirm / edit ----
  async getSummary(summaryId: string): Promise<SummaryRow | null> {
    const { data, error } = await this.db
      .from('summaries')
      .select('id, group_id, summary_text, created_at, groups(line_group_id)')
      .eq('id', summaryId)
      .maybeSingle()
    check('getSummary', error)
    const row = data as unknown as {
      id: string; group_id: string; summary_text: string; created_at: string; groups: { line_group_id: string }
    } | null
    if (!row) return null
    return {
      id: row.id, groupId: row.group_id, lineGroupId: row.groups.line_group_id,
      summaryText: row.summary_text, createdAt: toDate(row.created_at),
    }
  }

  async listCandidates(summaryId: string): Promise<CandidateRow[]> {
    const { data, error } = await this.db
      .from('task_candidates')
      .select(CANDIDATE_COLS)
      .eq('summary_id', summaryId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    check('listCandidates', error)
    return ((data ?? []) as DbCandidate[]).map(toCandidateRow)
  }

  async decideCandidate(
    candidateId: string, state: 'confirmed' | 'declined', decidedBy: string, decidedAt: Date,
  ): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('task_candidates')
      .update({ state, decided_by_line_user_id: decidedBy, decided_at: decidedAt.toISOString() })
      .eq('id', candidateId)
      .eq('state', 'proposed')
      .select('id')
    check('decideCandidate', error)
    return { updated: (data ?? []).length === 1 }
  }

  async confirmCandidate(
    t: NewTask, decidedAt: Date,
  ): Promise<{ outcome: 'created' | 'already_decided'; taskId: string | null }> {
    const { data, error } = await this.db.rpc('confirm_candidate', {
      p_candidate_id: t.candidateId, p_group_id: t.groupId, p_title: t.title, p_details: t.details,
      p_status: t.status, p_assignee: t.assigneeLineUserId, p_created_by: t.createdByLineUserId,
      p_due_at: iso(t.dueAt), p_decided_at: decidedAt.toISOString(),
    })
    check('confirmCandidate', error)
    const row = ((data ?? []) as { outcome: string; task_id: string | null }[])[0]
    if (!row || (row.outcome !== 'created' && row.outcome !== 'already_decided')) {
      throw new Error('confirmCandidate: unexpected result from confirm_candidate')
    }
    return { outcome: row.outcome, taskId: row.task_id }
  }

  async getTask(taskId: string): Promise<TaskRow | null> {
    const { data, error } = await this.db.from('tasks').select(TASK_COLS).eq('id', taskId).maybeSingle()
    check('getTask', error)
    return data ? toTaskRow(data as unknown as DbTask) : null
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('tasks')
      .update({
        title: patch.title, details: patch.details, assignee_line_user_id: patch.assigneeLineUserId,
        status: patch.status, due_at: iso(patch.dueAt), last_edited_by_line_user_id: patch.lastEditedByLineUserId,
        last_activity_at: patch.lastActivityAt.toISOString(),
      })
      .eq('id', taskId)
      .is('deleted_at', null)
      .select('id')
    check('updateTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  // ---- #7 Track progress ----
  async listOpenTasks(groupId: string): Promise<TaskRow[]> {
    const { data, error } = await this.db
      .from('tasks')
      .select(TASK_COLS)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      .neq('status', 'done')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
    check('listOpenTasks', error)
    return ((data ?? []) as unknown as DbTask[]).map(toTaskRow)
  }

  async getMessageRef(messageId: string): Promise<MessageRef | null> {
    const { data, error } = await this.db
      .from('messages')
      .select('id, group_id, sender_line_user_id, sent_at')
      .eq('id', messageId)
      .maybeSingle()
    check('getMessageRef', error)
    const row = data as { id: string; group_id: string; sender_line_user_id: string | null; sent_at: string } | null
    return row ? { id: row.id, groupId: row.group_id, senderLineUserId: row.sender_line_user_id, sentAt: toDate(row.sent_at) } : null
  }

  async findOpenProgressPrompt(taskId: string): Promise<ProgressPromptRow | null> {
    const { data, error } = await this.db
      .from('task_prompts')
      .select(PROMPT_COLS)
      .eq('task_id', taskId)
      .eq('kind', 'mark_done')
      .is('answer', null)
      .maybeSingle()
    check('findOpenProgressPrompt', error)
    return data ? toPromptRow(data as DbPrompt) : null
  }

  async createProgressPrompt(p: NewProgressPrompt): Promise<{ prompt: ProgressPromptRow | null }> {
    const { data, error } = await this.db
      .from('task_prompts')
      .insert({
        group_id: p.groupId, task_id: p.taskId, kind: 'mark_done', target_status: p.targetStatus,
        subject_line_user_id: p.subjectLineUserId, trigger_message_id: p.triggerMessageId,
        asked_at: p.askedAt.toISOString(),
      })
      .select(PROMPT_COLS)
      .single()
    // 23505 = unique_violation on task_prompts_one_open_mark_done: an open card already exists.
    if (error?.code === '23505') return { prompt: null }
    check('createProgressPrompt', error)
    return { prompt: toPromptRow(data as DbPrompt) }
  }

  async getProgressPrompt(promptId: string): Promise<ProgressPromptRow | null> {
    const { data, error } = await this.db
      .from('task_prompts')
      .select(PROMPT_COLS)
      .eq('id', promptId)
      .eq('kind', 'mark_done')
      .maybeSingle()
    check('getProgressPrompt', error)
    return data ? toPromptRow(data as DbPrompt) : null
  }

  async answerProgressPrompt(
    promptId: string, answer: 'no', byLineUserId: string, at: Date,
  ): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('task_prompts')
      .update({ answer, answered_by_line_user_id: byLineUserId, answered_at: at.toISOString() })
      .eq('id', promptId)
      .eq('kind', 'mark_done')
      .is('answer', null)
      .select('id')
    check('answerProgressPrompt', error)
    return { updated: (data ?? []).length === 1 }
  }

  async confirmProgressYes(y: ProgressYes): Promise<{ outcome: ProgressYesOutcome }> {
    const { data, error } = await this.db.rpc('answer_progress_yes', {
      p_prompt_id: y.promptId, p_task_id: y.taskId, p_from_status: y.fromStatus, p_to_status: y.toStatus,
      p_by: y.byLineUserId, p_assign_to: y.assignTo, p_at: y.at.toISOString(),
    })
    check('confirmProgressYes', error)
    if (data !== 'updated' && data !== 'already_answered' && data !== 'task_changed') {
      throw new Error('confirmProgressYes: unexpected result from answer_progress_yes')
    }
    return { outcome: data }
  }

  async withdrawProgressPrompt(promptId: string): Promise<void> {
    const { error } = await this.db
      .from('task_prompts')
      .delete()
      .eq('id', promptId)
      .eq('kind', 'mark_done')
      .is('answer', null)
    check('withdrawProgressPrompt', error)
  }

  // ---- #5 / #6 usage ----
  /** claim_ai_usage takes a per-Owner advisory lock, re-sums the month and inserts the open claim. */
  async claimAiUsage(u: NewAiUsage, cap: AiUsageCap): Promise<{ claimId: string | null }> {
    const { data, error } = await this.db.rpc('claim_ai_usage', {
      p_owner_line_user_id: u.ownerLineUserId, p_project_id: u.projectId, p_group_id: u.groupId, p_purpose: u.purpose,
      p_model: u.model, p_input_tokens: u.inputTokens, p_output_tokens: u.outputTokens, p_cost_usd: u.costUsd,
      p_created_at: u.createdAt.toISOString(), p_cap_tokens: cap.capTokens, p_cap_cost_usd: cap.capCostUsd,
    })
    check('claimAiUsage', error)
    return { claimId: typeof data === 'string' ? data : null }
  }

  async settleAiUsage(claimId: string, actual: AiUsageActual): Promise<void> {
    const { data, error } = await this.db.rpc('settle_ai_usage', {
      p_id: claimId, p_model: actual.model, p_input_tokens: actual.inputTokens,
      p_output_tokens: actual.outputTokens, p_cost_usd: actual.costUsd,
    })
    check('settleAiUsage', error)
    if (data !== true) throw new AdapterError('supabase settleAiUsage: claim not found')
  }

  async releaseAiUsage(claimId: string): Promise<void> {
    const { error } = await this.db.rpc('release_ai_usage', { p_id: claimId })
    check('releaseAiUsage', error)
  }

  /** One view row per Owner per Bangkok month; never sums rows in JS (max_rows would truncate). */
  async sumOwnerMonthUsage(ownerLineUserId: string, monthStartBkk: string): Promise<{ tokens: number; costMicroUsd: number }> {
    const { data, error } = await this.db
      .from('owner_monthly_usage')
      .select('total_tokens, total_cost_usd')
      .eq('owner_line_user_id', ownerLineUserId)
      .eq('month_start_bkk', `${monthStartBkk}T00:00:00`) // zoneless timestamp, Bangkok wall clock
      .maybeSingle()
    check('sumOwnerMonthUsage', error)
    const row = data as { total_tokens: number | string; total_cost_usd: number | string } | null
    if (!row) return { tokens: 0, costMicroUsd: 0 }
    // bigint and numeric may arrive as strings.
    return { tokens: Number(row.total_tokens), costMicroUsd: Math.round(Number(row.total_cost_usd) * 1e6) }
  }

  async claimFairUseNotice(n: {
    ownerLineUserId: string; groupId: string; monthStartBkk: string; kind: 'warn_80'
  }): Promise<{ inserted: boolean }> {
    const { data, error } = await this.db
      .from('fair_use_notices')
      .upsert(
        { owner_line_user_id: n.ownerLineUserId, group_id: n.groupId, month_start_bkk: n.monthStartBkk, kind: n.kind },
        { onConflict: 'owner_line_user_id,group_id,month_start_bkk,kind', ignoreDuplicates: true },
      )
      .select('kind')
    check('claimFairUseNotice', error)
    return { inserted: (data ?? []).length === 1 }
  }

  // ---- #12 Google ----
  async upsertGoogleAccount(a: NewGoogleAccount): Promise<void> {
    // refresh_token_ciphertext is text: the sealed 'v1.<iv>.<tag>.<ct>' string as-is.
    const { error } = await this.db.from('google_accounts').upsert(
      {
        line_user_id: a.lineUserId, google_subject: a.googleSubject, email: a.email,
        granted_scopes: a.grantedScopes, refresh_token_ciphertext: a.refreshTokenCiphertext, token_status: 'valid',
      },
      { onConflict: 'google_subject' },
    )
    check('upsertGoogleAccount', error)
  }

  async findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired' } | null> {
    const { data, error } = await this.db
      .from('google_accounts')
      .select('id, token_status')
      .eq('line_user_id', lineUserId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    check('findGoogleAccountByLineUser', error)
    const row = data as { id: string; token_status: 'valid' | 'revoked' | 'expired' } | null
    return row ? { id: row.id, tokenStatus: row.token_status } : null
  }
}
