import type { SupabaseClient } from '@supabase/supabase-js'
import { AdapterError } from '../log'
import type {
  AiUsageActual,
  AiUsageCap,
  AnnounceClaim,
  CandidateRow,
  DailyReminderGroup,
  DriveContext,
  DriveGroup,
  DashboardGroupRow,
  DashboardMemberRow,
  DashboardMembership,
  DashboardTaskRow,
  GroupRow,
  GroupSetup,
  GroupSetupWrite,
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
  OwnerConfirmOutcome,
  PushBudgetClaim,
  NewWeeklyInsight,
  ProgressAnswer,
  ProgressPromptRow,
  ReminderTask,
  SetupOutcome,
  StorePort,
  StoredMessage,
  SummaryRow,
  TaskCounts,
  TaskPatch,
  TaskRow,
  TaskStatus,
  UnownedTask,
  WeeklySummaryGroup,
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
const SETUP_COLS =
  'id, line_group_id, name, project_id, work_description, feature_summarize, feature_draft_tasks, feature_save_files, feature_track_remind, feature_weekly_summary, daily_reminder_time, weekly_summary_weekday, weekly_summary_time, nominated_owner_line_user_id, owner_confirmed_at, owner_nominated_at'
type DbGroupSetup = {
  id: string; line_group_id: string; name: string | null; project_id: string | null; work_description: string | null
  feature_summarize: boolean; feature_draft_tasks: boolean; feature_save_files: boolean
  feature_track_remind: boolean; feature_weekly_summary: boolean
  daily_reminder_time: string; weekly_summary_weekday: number; weekly_summary_time: string
  nominated_owner_line_user_id: string | null; owner_confirmed_at: string | null; owner_nominated_at: string | null
}
const CANDIDATE_COLS =
  'id, summary_id, state, title, details, suggested_assignee_line_user_id, suggested_due_at'
const TASK_COLS =
  'id, group_id, candidate_id, title, details, status, assignee_line_user_id, created_by_line_user_id, due_at, deleted_at, announced_at, groups(line_group_id)'
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

/**
 * Page size of every paged list read; equal to PostgREST max_rows in supabase/config.toml,
 * which caps each answer.
 */
export const PAGE_SIZE = 1000

/**
 * Page size for listWeeklySummaryGroups.
 */
export const WEEKLY_PAGE = 1000

/**
 * Page size of the Dashboard reads; equal to PostgREST max_rows too.
 */
export const DASHBOARD_PAGE = 1000

type PgError = { code: string } | null

function check(method: keyof StorePort, error: PgError): void {
  if (error) throw new AdapterError(`supabase ${method}: ${error.code}`)
}

/** IN lists go out this many values at a time, so the request URL stays short
 *  (a LINE user ID or a UUID is 33 to 36 characters). */
export const IN_CHUNK = 100

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK))
  return out
}

/** Every row of a list read, PAGE_SIZE rows at a time, so max_rows never hides the rows
 *  after the first page. `page(from, to)` is the query with .order() on a unique key (id)
 *  and .range(from, to); a short page is the last one. */
async function readAllPages<R>(
  method: keyof StorePort,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: PgError }>,
): Promise<R[]> {
  const out: R[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    check(method, error)
    const rows = (data ?? []) as R[]
    out.push(...rows)
    if (rows.length < PAGE_SIZE) return out
  }
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

  // ---- #24 unsend ----
  async deleteMessageByLineId(lineMessageId: string): Promise<{ deleted: boolean }> {
    const { data, error } = await this.db
      .from('messages')
      .delete()
      .eq('line_message_id', lineMessageId)
      .select('id')
    check('deleteMessageByLineId', error)
    return { deleted: (data ?? []).length > 0 }
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

  // Several statements, no RPC: each one is atomic, and its WHERE clause is
  // rechecked against the locked row, so two claims do not both take a batch as long
  // as they lock rows in a consistent order. A concurrent re-claim can still abort on
  // a deadlock; the batch then recovers through the stale path.
  async claimTaskAnnouncements(c: AnnounceClaim): Promise<{ taskId: string; token: string }[]> {
    if (c.taskIds.length === 0) return []
    type Held = { id: string; announce_pending_token: string }
    const held = await this.db
      .from('tasks')
      .select('id, announce_pending_token')
      .in('id', c.taskIds)
      .is('announced_at', null)
      .is('deleted_at', null)
      .not('announce_pending_token', 'is', null)
    check('claimTaskAnnouncements', held.error)
    const tokens = [...new Set(((held.data ?? []) as Held[]).map((r) => r.announce_pending_token))]
    const out: { taskId: string; token: string }[] = []
    if (tokens.length > 0) {
      // A released batch (pending_at null), then a stale one; a live claim is left alone.
      const released = await this.db
        .from('tasks')
        .update({ announce_pending_at: c.at.toISOString() })
        .in('announce_pending_token', tokens)
        .is('announced_at', null)
        .is('deleted_at', null)
        .is('announce_pending_at', null)
        .select('id, announce_pending_token')
      check('claimTaskAnnouncements', released.error)
      const stale = await this.db
        .from('tasks')
        .update({ announce_pending_at: c.at.toISOString() })
        .in('announce_pending_token', tokens)
        .is('announced_at', null)
        .is('deleted_at', null)
        .lt('announce_pending_at', c.staleBefore.toISOString())
        .select('id, announce_pending_token')
      check('claimTaskAnnouncements', stale.error)
      for (const r of [...((released.data ?? []) as Held[]), ...((stale.data ?? []) as Held[])]) {
        out.push({ taskId: r.id, token: r.announce_pending_token })
      }
    }
    const fresh = await this.db
      .from('tasks')
      .update({ announce_pending_token: c.token, announce_pending_at: c.at.toISOString() })
      .in('id', c.taskIds)
      .is('announced_at', null)
      .is('deleted_at', null)
      .is('announce_pending_token', null)
      .select('id')
    check('claimTaskAnnouncements', fresh.error)
    for (const r of (fresh.data ?? []) as { id: string }[]) out.push({ taskId: r.id, token: c.token })
    return out
  }

  async confirmTaskAnnouncements(token: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('tasks')
      .update({ announced_at: at.toISOString(), announce_pending_token: null, announce_pending_at: null })
      .eq('announce_pending_token', token)
      .is('announced_at', null)
    check('confirmTaskAnnouncements', error)
  }

  async releaseTaskAnnouncements(token: string, claimedAt: Date): Promise<void> {
    const { error } = await this.db
      .from('tasks')
      .update({ announce_pending_at: null })
      .eq('announce_pending_token', token)
      .eq('announce_pending_at', claimedAt.toISOString())
      .is('announced_at', null)
    check('releaseTaskAnnouncements', error)
  }

  async abandonTaskAnnouncements(token: string, claimedAt: Date): Promise<void> {
    const { error } = await this.db
      .from('tasks')
      .update({ announce_pending_token: null, announce_pending_at: null })
      .eq('announce_pending_token', token)
      .eq('announce_pending_at', claimedAt.toISOString())
      .is('announced_at', null)
    check('abandonTaskAnnouncements', error)
  }

  async claimPushBudget(c: PushBudgetClaim): Promise<{ pushLogId: string | null }> {
    const { data, error } = await this.db.rpc('claim_push_budget', {
      p_purpose: c.purpose, p_line_target_id: c.lineTargetId, p_message_count: c.messageCount,
      p_line_used: c.lineUsed, p_allowed: c.allowed,
    })
    check('claimPushBudget', error)
    return { pushLogId: typeof data === 'string' ? data : null }
  }

  async releasePushBudget(pushLogId: string): Promise<void> {
    const { error } = await this.db.from('push_log').delete().eq('id', pushLogId)
    check('releasePushBudget', error)
  }

  async listTasksByCandidates(candidateIds: string[]): Promise<TaskRow[]> {
    if (candidateIds.length === 0) return []
    const { data, error } = await this.db.from('tasks').select(TASK_COLS).in('candidate_id', candidateIds)
    check('listTasksByCandidates', error)
    return ((data ?? []) as unknown as DbTask[]).map(toTaskRow)
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

  // ---- #20 weekly insight ----
  /** Pages of PAGE_SIZE rows ordered by id, so PostgREST max_rows (1000) never hides
   *  the groups after the first page. */
  async listWeeklySummaryGroups(weekday: number): Promise<WeeklySummaryGroup[]> {
    type Row = {
      id: string; line_group_id: string; weekly_summary_weekday: number
      weekly_summary_time: string; weekly_summary_last_sent_on: string | null
    }
    const out: WeeklySummaryGroup[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.db
        .from('groups')
        .select('id, line_group_id, weekly_summary_weekday, weekly_summary_time, weekly_summary_last_sent_on')
        .not('project_id', 'is', null)
        .is('left_at', null)
        .eq('feature_weekly_summary', true)
        .eq('weekly_summary_weekday', weekday)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      check('listWeeklySummaryGroups', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) {
        out.push({
          groupId: r.id, lineGroupId: r.line_group_id, weekday: r.weekly_summary_weekday,
          time: r.weekly_summary_time, lastSentOn: r.weekly_summary_last_sent_on,
        })
      }
      if (rows.length < PAGE_SIZE) return out
    }
  }

  async claimWeeklySummary(groupId: string, todayBkk: string): Promise<{ claimed: boolean }> {
    const { data, error } = await this.db
      .from('groups')
      .update({ weekly_summary_last_sent_on: todayBkk })
      .eq('id', groupId)
      .or(`weekly_summary_last_sent_on.is.null,weekly_summary_last_sent_on.lt.${todayBkk}`)
      .select('id')
    check('claimWeeklySummary', error)
    return { claimed: (data?.length ?? 0) > 0 }
  }

  async releaseWeeklySummary(groupId: string, todayBkk: string, previous: string | null): Promise<void> {
    const { error } = await this.db
      .from('groups')
      .update({ weekly_summary_last_sent_on: previous })
      .eq('id', groupId)
      .eq('weekly_summary_last_sent_on', todayBkk)
    check('releaseWeeklySummary', error)
  }

  /** One head-only count per status: no rows travel, so max_rows (1000) cannot cut the count. */
  async countTasksByStatus(groupId: string): Promise<TaskCounts> {
    const count = async (status: TaskStatus): Promise<number> => {
      const { count: n, error } = await this.db
        .from('tasks')
        .select('id', { count: 'exact', head: true })
        .eq('group_id', groupId)
        .eq('status', status)
        .is('deleted_at', null)
      check('countTasksByStatus', error)
      return n ?? 0
    }
    const [done, inProcess, awaitingOwner] = await Promise.all([count('done'), count('in_process'), count('not_assigned')])
    return { done, inProcess, awaitingOwner }
  }

  async listUnownedTasks(groupId: string, limit: number): Promise<UnownedTask[]> {
    const { data, error } = await this.db
      .from('tasks')
      .select('id, title, due_at')
      .eq('group_id', groupId)
      .eq('status', 'not_assigned')
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit)
    check('listUnownedTasks', error)
    const rows = (data ?? []) as { id: string; title: string; due_at: string | null }[]
    return rows.map((r) => ({ id: r.id, title: r.title, dueAt: toDate(r.due_at) }))
  }

  async saveWeeklyInsight(i: NewWeeklyInsight): Promise<{ inserted: boolean }> {
    const { data, error } = await this.db
      .from('weekly_insights')
      .upsert(
        {
          group_id: i.groupId, week_start: i.weekStart, tasks_done: i.counts.done,
          tasks_in_process: i.counts.inProcess, tasks_awaiting_owner: i.counts.awaitingOwner,
          created_at: i.createdAt.toISOString(),
        },
        { onConflict: 'group_id,week_start', ignoreDuplicates: true },
      )
      .select('id')
    check('saveWeeklyInsight', error)
    return { inserted: (data ?? []).length === 1 }
  }

  async hasWeeklyInsight(groupId: string, weekStart: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('weekly_insights')
      .select('id')
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .maybeSingle()
    check('hasWeeklyInsight', error)
    return data !== null
  }

  async markWeeklyInsightPosted(groupId: string, weekStart: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('weekly_insights')
      .update({ posted_at: at.toISOString() })
      .eq('group_id', groupId)
      .eq('week_start', weekStart)
      .is('posted_at', null)
    check('markWeeklyInsightPosted', error)
  }

  // ---- #44 daily reminders ----
  /** Pages of PAGE_SIZE rows ordered by id, as listWeeklySummaryGroups. */
  async listDailyReminderGroups(): Promise<DailyReminderGroup[]> {
    type Row = { id: string; line_group_id: string; daily_reminder_time: string; daily_reminder_last_sent_on: string | null }
    const out: DailyReminderGroup[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.db
        .from('groups')
        .select('id, line_group_id, daily_reminder_time, daily_reminder_last_sent_on')
        .not('project_id', 'is', null)
        .is('left_at', null)
        .eq('feature_track_remind', true)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      check('listDailyReminderGroups', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) {
        out.push({ groupId: r.id, lineGroupId: r.line_group_id, time: r.daily_reminder_time, lastSentOn: r.daily_reminder_last_sent_on })
      }
      if (rows.length < PAGE_SIZE) return out
    }
  }

  async claimDailyReminder(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }> {
    // One logic tree, so both conditions hold: the day is not complete, and no live claim.
    const notSent = `or(daily_reminder_last_sent_on.is.null,daily_reminder_last_sent_on.lt.${todayBkk})`
    const noLiveClaim = `or(daily_reminder_claimed_at.is.null,daily_reminder_claimed_at.lt."${staleBefore.toISOString()}")`
    const { data, error } = await this.db
      .from('groups')
      .update({ daily_reminder_claimed_at: at.toISOString() })
      .eq('id', groupId)
      .or(`and(${notSent},${noLiveClaim})`)
      .select('id')
    check('claimDailyReminder', error)
    return { claimed: (data?.length ?? 0) > 0 }
  }

  async finishDailyReminder(groupId: string, todayBkk: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('groups')
      .update({ daily_reminder_last_sent_on: todayBkk, daily_reminder_claimed_at: null })
      .eq('id', groupId)
      .eq('daily_reminder_claimed_at', at.toISOString())
    check('finishDailyReminder', error)
  }

  async releaseDailyReminder(groupId: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('groups')
      .update({ daily_reminder_claimed_at: null })
      .eq('id', groupId)
      .eq('daily_reminder_claimed_at', at.toISOString())
    check('releaseDailyReminder', error)
  }

  // ---- #45 reminder answers ----
  // Done and Postpone also require `by` to still own the Task, so a reassignment between the
  // check and the write is never overridden by the former owner.
  async markTaskDone(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    const at = t.at.toISOString()
    const { data, error } = await this.db
      .from('tasks')
      .update({ status: 'done', done_at: at, last_activity_at: at, last_edited_by_line_user_id: t.by })
      .eq('id', t.taskId)
      .is('deleted_at', null)
      .eq('assignee_line_user_id', t.by) // still the owner at write time
      .neq('status', 'done')
      .select('id')
    check('markTaskDone', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  async postponeTask(t: { taskId: string; dueAt: Date; by: string; at: Date }): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('tasks')
      .update({ due_at: t.dueAt.toISOString(), last_activity_at: t.at.toISOString(), last_edited_by_line_user_id: t.by })
      .eq('id', t.taskId)
      .is('deleted_at', null)
      .eq('assignee_line_user_id', t.by) // still the owner at write time
      .neq('status', 'done')
      .select('id')
    check('postponeTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  async takeTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    const at = t.at.toISOString()
    const { data, error } = await this.db
      .from('tasks')
      .update({ assignee_line_user_id: t.by, status: 'in_process', last_activity_at: at, last_edited_by_line_user_id: t.by })
      .eq('id', t.taskId)
      .is('deleted_at', null)
      .is('assignee_line_user_id', null)
      .neq('status', 'done')
      .select('id')
    check('takeTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  /** Every open Task, in pages of PAGE_SIZE ordered by created_at then id, so PostgREST
   *  max_rows (1000) never hides newer (possibly more urgent) Tasks from the selection. */
  async listReminderTasks(groupId: string): Promise<ReminderTask[]> {
    type Row = {
      id: string; title: string; status: TaskStatus; assignee_line_user_id: string | null
      due_at: string | null; last_activity_at: string | null; deleted_at: string | null
    }
    const out: ReminderTask[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.db
        .from('tasks')
        .select('id, title, status, assignee_line_user_id, due_at, last_activity_at, deleted_at')
        .eq('group_id', groupId)
        .is('deleted_at', null)
        .neq('status', 'done')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      check('listReminderTasks', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) {
        out.push({
          id: r.id, title: r.title, status: r.status, assigneeLineUserId: r.assignee_line_user_id,
          dueAt: toDate(r.due_at), lastActivityAt: toDate(r.last_activity_at), deletedAt: toDate(r.deleted_at),
        })
      }
      if (rows.length < PAGE_SIZE) return out
    }
  }

  // ---- #52 onboarding ----
  async setGroupName(groupId: string, name: string): Promise<void> {
    const { error } = await this.db.from('groups').update({ name }).eq('id', groupId)
    check('setGroupName', error)
  }

  async getGroupSetup(groupId: string): Promise<GroupSetup | null> {
    const { data, error } = await this.db.from('groups').select(SETUP_COLS).eq('id', groupId).maybeSingle()
    check('getGroupSetup', error)
    const r = data as DbGroupSetup | null
    if (!r) return null
    return {
      groupId: r.id, lineGroupId: r.line_group_id, name: r.name, projectId: r.project_id,
      workDescription: r.work_description,
      features: {
        summarize: r.feature_summarize, draftTasks: r.feature_draft_tasks, saveFiles: r.feature_save_files,
        trackRemind: r.feature_track_remind, weeklySummary: r.feature_weekly_summary,
      },
      // time columns arrive as 'HH:MM:SS'; the form speaks 'HH:MM'.
      dailyReminderTime: r.daily_reminder_time.slice(0, 5),
      weeklySummaryWeekday: r.weekly_summary_weekday,
      weeklySummaryTime: r.weekly_summary_time.slice(0, 5),
      nominatedOwnerLineUserId: r.nominated_owner_line_user_id, ownerConfirmedAt: toDate(r.owner_confirmed_at),
      ownerNominatedAt: toDate(r.owner_nominated_at),
    }
  }

  async saveGroupSetup(w: GroupSetupWrite): Promise<{ outcome: SetupOutcome }> {
    const { data, error } = await this.db.rpc('setup_group', {
      p_group_id: w.groupId, p_by: w.byLineUserId, p_work_description: w.workDescription,
      p_feature_summarize: w.features.summarize, p_feature_draft_tasks: w.features.draftTasks,
      p_feature_save_files: w.features.saveFiles, p_feature_track_remind: w.features.trackRemind,
      p_feature_weekly_summary: w.features.weeklySummary,
      p_daily_reminder_time: w.dailyReminderTime, p_weekly_summary_weekday: w.weeklySummaryWeekday,
      p_weekly_summary_time: w.weeklySummaryTime,
      p_members: w.members.map((m) => ({ line_user_id: m.lineUserId, nicknames: m.nicknames, role: m.role })),
      p_owner: w.ownerLineUserId, p_at: w.at.toISOString(),
    })
    check('saveGroupSetup', error)
    if (data !== 'confirmed' && data !== 'pending' && data !== 'closed' && data !== 'owner_not_member') {
      throw new Error('saveGroupSetup: unexpected result from setup_group')
    }
    return { outcome: data }
  }

  async confirmGroupOwner(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerConfirmOutcome }> {
    const { data, error } = await this.db.rpc('confirm_group_owner', {
      p_group_id: groupId, p_line_user_id: lineUserId, p_at: at.toISOString(),
    })
    check('confirmGroupOwner', error)
    const outcomes: OwnerConfirmOutcome[] = ['confirmed', 'already_confirmed', 'not_nominee', 'not_member', 'closed']
    if (!outcomes.includes(data as OwnerConfirmOutcome)) {
      throw new Error('confirmGroupOwner: unexpected result from confirm_group_owner')
    }
    return { outcome: data as OwnerConfirmOutcome }
  }

  // ---- #17 Dashboard read ----
  async listDashboardMemberships(lineUserId: string): Promise<DashboardMembership[]> {
    type Row = {
      group_id: string; is_pm: boolean; left_at: string | null
      groups: { project_id: string; projects: { owner_line_user_id: string } }
    }
    const { data, error } = await this.db
      .from('group_members')
      .select('group_id, is_pm, left_at, groups!inner(project_id, left_at, projects!inner(owner_line_user_id))')
      .eq('line_user_id', lineUserId)
      .not('groups.project_id', 'is', null)
      .is('groups.left_at', null)
    check('listDashboardMemberships', error)
    return ((data ?? []) as unknown as Row[]).map((r) => ({
      groupId: r.group_id, projectId: r.groups.project_id,
      projectOwnerLineUserId: r.groups.projects.owner_line_user_id, isPm: r.is_pm, left: r.left_at !== null,
    }))
  }

  async listProjectGroups(projectIds: string[]): Promise<DashboardGroupRow[]> {
    if (projectIds.length === 0) return []
    type Row = { id: string; project_id: string; name: string | null }
    const out: DashboardGroupRow[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('groups')
        .select('id, project_id, name')
        .in('project_id', projectIds)
        .is('left_at', null)
        .order('is_main', { ascending: false })
        .order('joined_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listProjectGroups', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) out.push({ groupId: r.id, projectId: r.project_id, name: r.name })
      if (rows.length < DASHBOARD_PAGE) return out
    }
  }

  async listDashboardMembers(groupIds: string[]): Promise<DashboardMemberRow[]> {
    if (groupIds.length === 0) return []
    type Row = { group_id: string; line_user_id: string; line_users: { display_name: string | null } | null }
    const out: DashboardMemberRow[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('group_members')
        .select('group_id, line_user_id, line_users(display_name)')
        .in('group_id', groupIds)
        .is('left_at', null)
        .order('group_id')
        .order('first_seen_at', { ascending: true })
        .order('line_user_id')
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listDashboardMembers', error)
      const rows = (data ?? []) as unknown as Row[]
      for (const r of rows) out.push({ groupId: r.group_id, lineUserId: r.line_user_id, displayName: r.line_users?.display_name ?? null })
      if (rows.length < DASHBOARD_PAGE) return out
    }
  }

  async listDashboardTasks(groupIds: string[]): Promise<DashboardTaskRow[]> {
    if (groupIds.length === 0) return []
    type Row = {
      id: string; group_id: string; title: string; status: TaskStatus; assignee_line_user_id: string | null
      due_at: string | null; assignee: { display_name: string | null } | null
    }
    const out: DashboardTaskRow[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('tasks')
        .select('id, group_id, title, status, assignee_line_user_id, due_at, assignee:line_users!assignee_line_user_id(display_name)')
        .in('group_id', groupIds)
        .is('deleted_at', null)
        .order('group_id')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listDashboardTasks', error)
      const rows = (data ?? []) as unknown as Row[]
      for (const r of rows) {
        out.push({
          id: r.id, groupId: r.group_id, title: r.title, status: r.status,
          assigneeLineUserId: r.assignee_line_user_id, assigneeName: r.assignee?.display_name ?? null, dueAt: toDate(r.due_at),
        })
      }
      if (rows.length < DASHBOARD_PAGE) return out
    }
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

  // ---- #13 Drive folders ----
  async listConfirmedOwnerProjects(lineUserId: string): Promise<string[]> {
    // A confirmed main group names the Project's owner (check_same_owner), so the
    // groups row alone answers it.
    const rows = await readAllPages<{ project_id: string }>('listConfirmedOwnerProjects', (from, to) =>
      this.db
        .from('groups')
        .select('project_id')
        .eq('is_main', true)
        .eq('nominated_owner_line_user_id', lineUserId)
        .not('owner_confirmed_at', 'is', null)
        .not('project_id', 'is', null)
        .is('left_at', null)
        .order('id')
        .range(from, to))
    return rows.map((r) => r.project_id)
  }

  async getDriveContext(projectId: string): Promise<DriveContext | null> {
    const { data: p, error } = await this.db
      .from('projects')
      .select('id, owner_line_user_id, drive_project_folder_id')
      .eq('id', projectId)
      .maybeSingle()
    check('getDriveContext', error)
    const project = p as { id: string; owner_line_user_id: string; drive_project_folder_id: string | null } | null
    if (!project) return null
    type G = { id: string; line_group_id: string; name: string | null; is_main: boolean; drive_folder_id: string | null }
    const [rows, account, active] = await Promise.all([
      readAllPages<G>('getDriveContext', (from, to) =>
        this.db
          .from('groups')
          .select('id, line_group_id, name, is_main, drive_folder_id')
          .eq('project_id', projectId)
          .not('owner_confirmed_at', 'is', null)
          .is('left_at', null)
          .order('id')
          .range(from, to)),
      // The Owner's most recently written account, as findGoogleAccountByLineUser.
      this.db
        .from('google_accounts')
        .select('id, token_status, refresh_token_ciphertext, drive_root_folder_id')
        .eq('line_user_id', project.owner_line_user_id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      this.db
        .from('drive_connections')
        .select('google_account_id')
        .eq('project_id', projectId)
        .eq('status', 'active')
        .maybeSingle(),
    ])
    check('getDriveContext', account.error)
    check('getDriveContext', active.error)
    const toDrive = (g: G): DriveGroup => ({
      groupId: g.id, lineGroupId: g.line_group_id, name: g.name, folderId: g.drive_folder_id,
    })
    const main = rows.find((g) => g.is_main)
    const a = account.data as {
      id: string; token_status: 'valid' | 'revoked' | 'expired'
      refresh_token_ciphertext: string | null; drive_root_folder_id: string | null
    } | null
    return {
      projectId, ownerLineUserId: project.owner_line_user_id, projectFolderId: project.drive_project_folder_id,
      mainGroup: main ? toDrive(main) : null,
      subGroups: rows.filter((g) => !g.is_main).map(toDrive),
      account: a
        ? { id: a.id, tokenStatus: a.token_status, refreshTokenCiphertext: a.refresh_token_ciphertext, rootFolderId: a.drive_root_folder_id }
        : null,
      activeAccountId: (active.data as { google_account_id: string } | null)?.google_account_id ?? null,
    }
  }

  async setDriveRootFolder(googleAccountId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    return this.setFolder('setDriveRootFolder', 'google_accounts', 'drive_root_folder_id', googleAccountId, from, to)
  }

  async setProjectDriveFolder(projectId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    return this.setFolder('setProjectDriveFolder', 'projects', 'drive_project_folder_id', projectId, from, to)
  }

  async setGroupDriveFolder(groupId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    return this.setFolder('setGroupDriveFolder', 'groups', 'drive_folder_id', groupId, from, to)
  }

  /** One UPDATE ... WHERE id = $1 AND col IS NOT DISTINCT FROM `from`; when it matched no
   *  row, reads what the column holds now. */
  private async setFolder(
    method: keyof StorePort, table: string, column: string, id: string, from: string | null, to: string,
  ): Promise<{ folderId: string | null }> {
    const base = this.db.from(table).update({ [column]: to }).eq('id', id)
    const { data, error } = await (from === null ? base.is(column, null) : base.eq(column, from)).select('id')
    check(method, error)
    if (((data ?? []) as unknown[]).length > 0) return { folderId: to }
    const { data: row, error: readError } = await this.db.from(table).select(column).eq('id', id).maybeSingle()
    check(method, readError)
    return { folderId: ((row as Record<string, string | null> | null)?.[column]) ?? null }
  }

  async claimDriveConnection(projectId: string, googleAccountId: string): Promise<{ created: boolean; accountId: string }> {
    const holder = async (): Promise<string | null> => {
      const { data, error } = await this.db
        .from('drive_connections')
        .select('google_account_id')
        .eq('project_id', projectId)
        .eq('status', 'active')
        .limit(1)
      check('claimDriveConnection', error)
      return ((data ?? []) as { google_account_id: string }[])[0]?.google_account_id ?? null
    }
    const held = await holder()
    if (held !== null) return { created: false, accountId: held }
    // The partial unique index drive_connections_one_active cannot be an ON CONFLICT
    // target through PostgREST, so a concurrent claim shows as 23505: that claim holds it.
    const { error: insertError } = await this.db
      .from('drive_connections')
      .insert({ project_id: projectId, google_account_id: googleAccountId, status: 'active' })
    if (insertError?.code === '23505') {
      const winner = await holder()
      if (winner === null) throw new AdapterError('supabase claimDriveConnection: no holder')
      return { created: false, accountId: winner }
    }
    check('claimDriveConnection', insertError)
    return { created: true, accountId: googleAccountId }
  }

  /** Flat reads joined here, no embedded filters: the Owners with a confirm or a Google
   *  account write since `from`, then their accounts and main groups, then, for the
   *  Projects in the window, the empty folder IDs and the active connection holders. Every
   *  read is paged; every IN list is chunked. */
  async listUnfinishedDriveProjects(from: Date, to: Date): Promise<string[]> {
    const m = 'listUnfinishedDriveProjects'
    const since = from.toISOString()
    const [confirmed, signedIn] = await Promise.all([
      readAllPages<{ nominated_owner_line_user_id: string }>(m, (a, b) =>
        this.db
          .from('groups')
          .select('nominated_owner_line_user_id')
          .eq('is_main', true)
          .not('project_id', 'is', null)
          .is('left_at', null)
          .gte('owner_confirmed_at', since)
          .order('id')
          .range(a, b)),
      readAllPages<{ line_user_id: string }>(m, (a, b) =>
        this.db
          .from('google_accounts')
          .select('line_user_id')
          .gte('updated_at', since)
          .order('id')
          .range(a, b)),
    ])
    const owners = [...new Set([
      ...confirmed.map((r) => r.nominated_owner_line_user_id), ...signedIn.map((r) => r.line_user_id),
    ])]

    type Account = { id: string; line_user_id: string; token_status: string; updated_at: string }
    type Main = { project_id: string; nominated_owner_line_user_id: string; owner_confirmed_at: string }
    const accounts: Account[] = []
    const mains: Main[] = []
    for (const chunk of chunks(owners)) {
      const [a, g] = await Promise.all([
        readAllPages<Account>(m, (x, y) =>
          this.db
            .from('google_accounts')
            .select('id, line_user_id, token_status, updated_at')
            .in('line_user_id', chunk)
            .order('id')
            .range(x, y)),
        readAllPages<Main>(m, (x, y) =>
          this.db
            .from('groups')
            .select('project_id, nominated_owner_line_user_id, owner_confirmed_at')
            .eq('is_main', true)
            .in('nominated_owner_line_user_id', chunk)
            .not('owner_confirmed_at', 'is', null)
            .not('project_id', 'is', null)
            .is('left_at', null)
            .order('id')
            .range(x, y)),
      ])
      accounts.push(...a)
      mains.push(...g)
    }

    // Each Owner's most recently written account, as getDriveContext reads it.
    const latest = new Map<string, Account>()
    for (const a of accounts) {
      const seen = latest.get(a.line_user_id)
      if (!seen || toDate(a.updated_at).getTime() > toDate(seen.updated_at).getTime()) latest.set(a.line_user_id, a)
    }
    // Project ID -> the account that would run it: in the window, with a valid latest account.
    const inWindow = new Map<string, string>()
    for (const g of mains) {
      const account = latest.get(g.nominated_owner_line_user_id)
      if (account?.token_status !== 'valid') continue
      const last = Math.max(toDate(g.owner_confirmed_at).getTime(), toDate(account.updated_at).getTime())
      if (last >= from.getTime() && last <= to.getTime()) inWindow.set(g.project_id, account.id)
    }

    const missing = new Set<string>() // a folder ID is still empty
    const holders = new Map<string, string>()
    for (const chunk of chunks([...inWindow.keys()])) {
      const [noProjectFolder, noGroupFolder, active] = await Promise.all([
        readAllPages<{ id: string }>(m, (x, y) =>
          this.db
            .from('projects')
            .select('id')
            .in('id', chunk)
            .is('drive_project_folder_id', null)
            .order('id')
            .range(x, y)),
        // The groups getDriveContext lists, so a Project is never pending for a group no run makes.
        readAllPages<{ project_id: string }>(m, (x, y) =>
          this.db
            .from('groups')
            .select('project_id')
            .in('project_id', chunk)
            .not('owner_confirmed_at', 'is', null)
            .is('left_at', null)
            .is('drive_folder_id', null)
            .order('id')
            .range(x, y)),
        readAllPages<{ project_id: string; google_account_id: string }>(m, (x, y) =>
          this.db
            .from('drive_connections')
            .select('project_id, google_account_id')
            .eq('status', 'active')
            .in('project_id', chunk)
            .order('id')
            .range(x, y)),
      ])
      for (const r of noProjectFolder) missing.add(r.id)
      for (const r of noGroupFolder) missing.add(r.project_id)
      for (const r of active) holders.set(r.project_id, r.google_account_id)
    }
    return [...inWindow]
      .filter(([id, accountId]) => missing.has(id) && (holders.get(id) ?? accountId) === accountId)
      .map(([id]) => id)
      .sort()
  }
}
