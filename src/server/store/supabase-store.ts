import type { SupabaseClient } from '@supabase/supabase-js'
import { AdapterError, logError } from '../log'
import { BOT_DELETE_AFTER_MS } from '../removal/leave'
import { failedReasonOf } from '../ports'
import type {
  ImageSetCount,
  AiUsageActual,
  AiUsageCap,
  AnnounceClaim,
  CandidateRow,
  CompleteOwnerChangeOutcome,
  DailyReminderGroup,
  DetachedSubGroup,
  MemberCheckGroup,
  DriveContext,
  DriveGroup,
  DashboardGroupRow,
  UserGroup,
  DashboardMemberRow,
  DashboardMembership,
  DashboardTaskRow,
  GroupRow,
  GroupSetup,
  GroupSettingsWrite, LatestWeeklyInsight, GroupSetupWrite,
  Member,
  Membership,
  MessageRef,
  QuotedFileLookup,
  DashboardFileRow,
  NewFile,
  SavedFile,
  NewAiUsage,
  NewCandidate,
  NewGoogleAccount,
  NewMessage,
  NewProgressPrompt,
  NewSummary,
  NewTask,
  NewWebhookEvent,
  OwnerChangeOutcome,
  PausedOwnerCard,
  OwnerChangeState,
  OwnerClaimOutcome,
  OwnerlessGroup,
  OwnerExitState,
  OwnerConfirmOutcome,
  TakeoverAnswerOutcome,
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
  ownerCountDue,
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
  'id, line_group_id, project_id, name, nominated_owner_line_user_id, owner_confirmed_at, feature_summarize, feature_draft_tasks, work_description, feature_track_remind, owner_left_at'
const SETUP_COLS =
  'id, line_group_id, name, project_id, work_description, feature_summarize, feature_draft_tasks, feature_save_files, feature_track_remind, feature_weekly_summary, daily_reminder_time, weekly_summary_weekday, weekly_summary_time, nominated_owner_line_user_id, owner_confirmed_at, owner_nominated_at, owner_left_at, tag_set'
type DbGroupSetup = {
  id: string; line_group_id: string; name: string | null; project_id: string | null; work_description: string | null
  feature_summarize: boolean; feature_draft_tasks: boolean; feature_save_files: boolean
  feature_track_remind: boolean; feature_weekly_summary: boolean
  daily_reminder_time: string; weekly_summary_weekday: number; weekly_summary_time: string
  nominated_owner_line_user_id: string | null; owner_confirmed_at: string | null; owner_nominated_at: string | null
  owner_left_at: string | null
  tag_set?: string[] | null
}
const CANDIDATE_COLS =
  'id, summary_id, state, title, details, suggested_assignee_line_user_id, suggested_due_at, suggested_tags'
const TASK_COLS =
  'id, group_id, candidate_id, title, details, status, assignee_line_user_id, created_by_line_user_id, due_at, deleted_at, announced_at, tags, groups(line_group_id)'
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

const FILE_COLS = 'id, group_id, message_id, file_name, drive_link, drive_file_id, size_bytes'
type DbFile = {
  id: string; group_id: string; message_id: string | null; file_name: string; drive_link: string
  drive_file_id: string; size_bytes: number | string | null   // bigint may come back as a string
}
function toSavedFile(r: DbFile): SavedFile {
  return {
    id: r.id, groupId: r.group_id, messageId: r.message_id, fileName: r.file_name, driveLink: r.drive_link,
    driveFileId: r.drive_file_id, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  }
}

function check(method: keyof StorePort, error: PgError): void {
  if (error) throw new AdapterError(`supabase ${method}: ${error.code}`)
}

/** #30 part B: the columns every detach with no confirmed Owner writes: a fresh 7-day Owner
 *  count and no nominee, so any live Member can claim the role (decided 2026-11-15, option B). */
function OWNER_COUNT(when: string) {
  return { owner_left_at: when, nominated_owner_line_user_id: null, owner_nominated_by_line_user_id: null, owner_nominated_at: null }
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

/** Settings writes this many Members' rows at once (#28). Agent choice. */
const SETTINGS_MEMBER_WRITES = 10

/** PostgREST filter: the row's last membership event is older than `iso`. A row from before
 *  membership_event_at existed falls back to left_at (its last applied leave), and a live
 *  row with neither has seen no event. */
function membershipOlderThan(iso: string): string {
  return `membership_event_at.lt."${iso}",and(membership_event_at.is.null,or(left_at.is.null,left_at.lt."${iso}"))`
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

  async hasWebhookEvent(webhookEventId: string): Promise<boolean> {
    const { data, error } = await this.db
      .from('webhook_events')
      .select('webhook_event_id')
      .eq('webhook_event_id', webhookEventId)
      .maybeSingle()
    check('hasWebhookEvent', error)
    return data !== null
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
  async unsendMessage(lineMessageId: string): Promise<{ deleted: boolean }> {
    // rpc unsend_message: the tombstone and the delete in one transaction, under the same
    // lock the messages insert trigger takes, so a late delivery is never stored again.
    const { data, error } = await this.db.rpc('unsend_message', { p_line_message_id: lineMessageId })
    check('unsendMessage', error)
    return { deleted: data === true }
  }

  // ---- #4 file saver ----
  async findFileByHash(groupId: string, contentSha256: string): Promise<SavedFile | null> {
    const { data, error } = await this.db
      .from('files')
      .select(FILE_COLS)
      .eq('group_id', groupId)
      .eq('content_sha256', contentSha256)
      .maybeSingle()
    check('findFileByHash', error)
    return data ? toSavedFile(data as unknown as DbFile) : null
  }

  async insertFile(f: NewFile): Promise<{ inserted: boolean; file: SavedFile }> {
    const { data, error } = await this.db
      .from('files')
      .upsert(
        {
          group_id: f.groupId, message_id: f.messageId, sender_line_user_id: f.senderLineUserId,
          drive_connection_id: f.driveConnectionId, file_name: f.fileName, content_sha256: f.contentSha256,
          drive_file_id: f.driveFileId, drive_link: f.driveLink, sent_at: f.sentAt.toISOString(),
          saved_at: f.savedAt.toISOString(), size_bytes: f.sizeBytes,
        },
        { onConflict: 'group_id,content_sha256', ignoreDuplicates: true },
      )
      .select(FILE_COLS)
    check('insertFile', error)
    const rows = (data ?? []) as unknown as DbFile[]
    if (rows.length === 1) return { inserted: true, file: toSavedFile(rows[0]) }
    // ON CONFLICT DO NOTHING returned nothing: the row of the save that got in first.
    const existing = await this.findFileByHash(f.groupId, f.contentSha256)
    if (!existing) throw new AdapterError('supabase insertFile: conflict row vanished')
    return { inserted: false, file: existing }
  }

  async linkFileToMessage(fileId: string, messageId: string): Promise<{ updated: boolean }> {
    // #140: a link row; files.message_id keeps the first message.
    const { error } = await this.db
      .from('file_messages')
      .upsert({ file_id: fileId, message_id: messageId }, { onConflict: 'file_id,message_id', ignoreDuplicates: true })
    // 23503: the file (group purged) or the message (unsent) is gone; nothing to link.
    if (error?.code === '23503') return { updated: false }
    check('linkFileToMessage', error)
    return { updated: true }
  }

  async findActiveDriveConnection(projectId: string): Promise<{ id: string; googleAccountId: string } | null> {
    const { data, error } = await this.db
      .from('drive_connections')
      .select('id, google_account_id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .limit(1)
    check('findActiveDriveConnection', error)
    const row = ((data ?? []) as { id: string; google_account_id: string }[])[0]
    return row ? { id: row.id, googleAccountId: row.google_account_id } : null
  }

  async countImageSet(groupId: string, imageSetId: string): Promise<ImageSetCount> {
    // A batch is a handful of photos (LINE sends at most a few dozen at once), so one page.
    const { data, error } = await this.db
      .from('messages')
      .select('line_message_id')
      .eq('group_id', groupId)
      .eq('image_set_id', imageSetId)
      .order('line_message_id', { ascending: true })
      .limit(PAGE_SIZE)
    check('countImageSet', error)
    const keys = ((data ?? []) as { line_message_id: string }[]).map((r) => `file:${r.line_message_id}`)
    if (keys.length === 0) return { messages: 0, saved: 0, failed: 0, failedReasons: [] }
    const rows: { event_type: string }[] = []
    // IN_CHUNK keys per request, so the URL stays short.
    for (const part of chunks(keys)) {
      const { data: settled, error: settledError } = await this.db
        .from('webhook_events')
        .select('webhook_event_id, event_type')
        .in('webhook_event_id', part)
      check('countImageSet', settledError)
      rows.push(...((settled ?? []) as { event_type: string }[]))
    }
    const failedReasons = rows.map((r) => failedReasonOf(r.event_type)).filter((r): r is string => r !== null)
    return {
      messages: keys.length,
      saved: rows.filter((r) => r.event_type === 'file_saved').length,
      failed: failedReasons.length,
      failedReasons,
    }
  }

  async claimImageSetCard(groupId: string, imageSetId: string): Promise<{ claimed: boolean }> {
    const { data, error } = await this.db
      .from('image_set_cards')
      .upsert({ group_id: groupId, image_set_id: imageSetId }, { onConflict: 'group_id,image_set_id', ignoreDuplicates: true })
      .select('image_set_id')
    check('claimImageSetCard', error)
    return { claimed: (data ?? []).length === 1 }
  }

  async listDashboardFiles(groupIds: string[], limit: number): Promise<DashboardFileRow[]> {
    type Row = {
      id: string; group_id: string; file_name: string; drive_link: string; size_bytes: number | string | null
      saved_at: string; line_users: { display_name: string | null } | null
    }
    const out: DashboardFileRow[] = []
    // One request per group: "newest N of each" has no PostgREST form across groups.
    for (const groupId of groupIds) {
      const { data, error } = await this.db
        .from('files')
        .select('id, group_id, file_name, drive_link, size_bytes, saved_at, line_users(display_name)')
        .eq('group_id', groupId)
        .order('saved_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit)
      check('listDashboardFiles', error)
      for (const r of (data ?? []) as unknown as Row[]) {
        out.push({
          id: r.id, groupId: r.group_id, fileName: r.file_name, driveLink: r.drive_link,
          sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), savedAt: new Date(r.saved_at),
          senderName: r.line_users?.display_name ?? null,
        })
      }
    }
    return out
  }

  // ---- #33 file request ----
  async findQuotedFile(groupId: string, lineMessageId: string): Promise<QuotedFileLookup> {
    // Scoped to the asking group: line_message_id is unique across groups, and a quote id
    // from elsewhere must not reveal another group's Drive link.
    const { data: message, error: messageError } = await this.db
      .from('messages')
      .select('id')
      .eq('group_id', groupId)
      .eq('line_message_id', lineMessageId)
      .maybeSingle()
    check('findQuotedFile', messageError)
    if (!message) return { kind: 'no_message' }
    // files.message_id is not unique, so take the newest row rather than maybeSingle().
    const { data: files, error: fileError } = await this.db
      .from('files')
      .select('file_name, drive_link')
      .eq('message_id', (message as { id: string }).id)
      .order('saved_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
    check('findQuotedFile', fileError)
    const file = ((files ?? []) as { file_name: string; drive_link: string }[])[0]
    if (file) return { kind: 'file', fileName: file.file_name, driveLink: file.drive_link }
    // #140: a later message that carried a file saved before.
    const { data: links, error: linkError } = await this.db
      .from('file_messages')
      .select('linked_at, files!inner(file_name, drive_link, group_id)')
      .eq('message_id', (message as { id: string }).id)
      .eq('files.group_id', groupId)
      .order('linked_at', { ascending: false })
      .limit(1)
    check('findQuotedFile', linkError)
    const linked = ((links ?? []) as unknown as { files: { file_name: string; drive_link: string } | null }[])[0]?.files
    return linked ? { kind: 'file', fileName: linked.file_name, driveLink: linked.drive_link } : { kind: 'no_file' }
  }

  // ---- #15 Summary ----
  async listRecentTextMessages(groupId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await this.db
      .from('messages')
      // Hint the FK: messages also references line_users through progress_dismissed_by_line_user_id
      // (20261115150000), so a bare line_users(...) embed is ambiguous (PostgREST PGRST201).
      .select('id, sender_line_user_id, text, sent_at, mentions, line_users!sender_line_user_id(display_name)')
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
          suggested_due_at: iso(c.suggestedDueAt), suggested_tags: c.suggestedTags, created_at: new Date(base + i).toISOString(),
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
    // #109: the tags go on in a second statement, so confirm_candidate stays as it is. A
    // failure here is logged and leaves the Task untagged: tags never block a Task.
    if (row.outcome === 'created' && row.task_id && t.tags.length > 0) {
      const tagged = await this.db.from('tasks').update({ tags: t.tags }).eq('id', row.task_id)
      if (tagged.error) logError('task_tags_failed', { taskId: row.task_id }, new AdapterError(`supabase confirmCandidate tags: ${tagged.error.code}`))
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
        last_activity_at: patch.lastActivityAt.toISOString(), tags: patch.tags,
      })
      .eq('id', taskId)
      .is('deleted_at', null)
      .select('id')
    check('updateTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  // ---- #7 Track progress ----
  async getLatestSummaryEnd(groupId: string): Promise<Date | null> {
    const { data, error } = await this.db
      .from('summaries')
      .select('last_message_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle()
    check('getLatestSummaryEnd', error)
    return toDate((data as { last_message_at: string | null } | null)?.last_message_at ?? null)
  }

  async listTasksForSummary(groupId: string, doneSince: Date, limit: number): Promise<TaskRow[]> {
    const since = doneSince.toISOString()
    const { data, error } = await this.db
      .from('tasks')
      .select(TASK_COLS)
      .eq('group_id', groupId)
      .is('deleted_at', null)
      // Open, or Done recently (a Task closed from the Task page may have no done_at).
      .or(`status.neq.done,done_at.gte.${since},last_activity_at.gte.${since}`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit)
    check('listTasksForSummary', error)
    return ((data ?? []) as unknown as DbTask[]).map(toTaskRow)
  }

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
      .select('id, group_id, sender_line_user_id, sent_at, progress_dismissed_at')
      .eq('id', messageId)
      .maybeSingle()
    check('getMessageRef', error)
    const row = data as {
      id: string; group_id: string; sender_line_user_id: string | null; sent_at: string; progress_dismissed_at: string | null
    } | null
    return row
      ? {
          id: row.id, groupId: row.group_id, senderLineUserId: row.sender_line_user_id, sentAt: toDate(row.sent_at),
          progressDismissedAt: toDate(row.progress_dismissed_at),
        }
      : null
  }

  async dismissProgressPicker(messageId: string, byLineUserId: string, at: Date): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('messages')
      .update({ progress_dismissed_at: at.toISOString(), progress_dismissed_by_line_user_id: byLineUserId })
      .eq('id', messageId)
      .is('progress_dismissed_at', null)
      .select('id')
    check('dismissProgressPicker', error)
    return { updated: (data ?? []).length === 1 }
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

  async listYesProgressPrompts(messageId: string): Promise<ProgressPromptRow[]> {
    const { data, error } = await this.db
      .from('task_prompts')
      .select(PROMPT_COLS)
      .eq('trigger_message_id', messageId)
      .eq('kind', 'mark_done')
      .eq('answer', 'yes')
      .order('answered_at', { ascending: true })
    check('listYesProgressPrompts', error)
    return ((data ?? []) as DbPrompt[]).map(toPromptRow)
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
    if (data !== 'updated' && data !== 'already_answered' && data !== 'task_changed' && data !== 'dismissed') {
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
        .is('owner_left_at', null)   // #30: paused while the group has no Owner
        .not('owner_confirmed_at', 'is', null) // as ownerBackedOn: a Sub group waiting on take-over too
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

  // ---- #32 daily member check ----
  /** Pages of PAGE_SIZE rows ordered by id, as listDailyReminderGroups. */
  async listMemberCheckGroups(): Promise<MemberCheckGroup[]> {
    type Row = { id: string; line_group_id: string; member_check_on: string | null }
    const out: MemberCheckGroup[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.db
        .from('groups')
        .select('id, line_group_id, member_check_on')
        .is('left_at', null)
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      check('listMemberCheckGroups', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) out.push({ groupId: r.id, lineGroupId: r.line_group_id, lastCheckedOn: r.member_check_on })
      if (rows.length < PAGE_SIZE) return out
    }
  }

  async claimMemberCheck(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }> {
    // One logic tree, as claimDailyReminder: the day is not checked, and no live claim.
    const notChecked = `or(member_check_on.is.null,member_check_on.lt.${todayBkk})`
    const noLiveClaim = `or(member_check_claimed_at.is.null,member_check_claimed_at.lt."${staleBefore.toISOString()}")`
    const { data, error } = await this.db
      .from('groups')
      .update({ member_check_claimed_at: at.toISOString() })
      .eq('id', groupId)
      .or(`and(${notChecked},${noLiveClaim})`)
      .select('id')
    check('claimMemberCheck', error)
    return { claimed: (data?.length ?? 0) > 0 }
  }

  async finishMemberCheck(groupId: string, todayBkk: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('groups')
      .update({ member_check_on: todayBkk, member_check_claimed_at: null })
      .eq('id', groupId)
      .eq('member_check_claimed_at', at.toISOString())
    check('finishMemberCheck', error)
  }

  async releaseMemberCheck(groupId: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('groups')
      .update({ member_check_claimed_at: null })
      .eq('id', groupId)
      .eq('member_check_claimed_at', at.toISOString())
    check('releaseMemberCheck', error)
  }

  /** Live rows of one group: at most a LINE group's 500 members, inside one PostgREST page. */
  async listMembersToCheck(groupId: string, todayBkk: string): Promise<string[]> {
    const { data, error } = await this.db
      .from('group_members')
      .select('line_user_id')
      .eq('group_id', groupId)
      .is('left_at', null)
      .or(`member_checked_on.is.null,member_checked_on.lt.${todayBkk}`)
      .order('line_user_id')
    check('listMembersToCheck', error)
    return ((data ?? []) as { line_user_id: string }[]).map((r) => r.line_user_id)
  }

  async markMemberChecked(groupId: string, lineUserId: string, todayBkk: string): Promise<void> {
    const { error } = await this.db
      .from('group_members')
      .update({ member_checked_on: todayBkk })
      .eq('group_id', groupId)
      .eq('line_user_id', lineUserId)
    check('markMemberChecked', error)
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

  async deleteTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('tasks')
      .update({ deleted_at: t.at.toISOString(), deleted_by_line_user_id: t.by })
      .eq('id', t.taskId)
      .is('deleted_at', null)
      .is('assignee_line_user_id', null)
      .neq('status', 'done')
      .select('id')
    check('deleteTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  async restoreTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('tasks')
      .update({ deleted_at: null, deleted_by_line_user_id: null, last_activity_at: t.at.toISOString(), last_edited_by_line_user_id: t.by })
      .eq('id', t.taskId)
      .not('deleted_at', 'is', null)
      .not('deleted_by_line_user_id', 'is', null) // a person's delete, never another kind
      .select('id')
    check('restoreTask', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  // ---- #29 member leaves ----
  async markMemberLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }> {
    const at = t.at.toISOString()
    // A person with no row yet gets a left row, so a message of theirs that arrives after
    // the leave (LINE does not guarantee order) cannot add them back: touchGroupMember only
    // inserts when no row exists. source 'message': seen through a group event.
    const { data: added, error: addError } = await this.db
      .from('group_members')
      .upsert(
        { group_id: t.groupId, line_user_id: t.lineUserId, source: 'message', left_at: at, membership_event_at: at },
        { onConflict: 'group_id,line_user_id', ignoreDuplicates: true },
      )
      .select('line_user_id')
    check('markMemberLeft', addError)
    if ((added?.length ?? 0) > 0) return { updated: true }
    // Only a leave newer than the last leave or join applied to the row. An older one (a late
    // first delivery after a rejoin) leaves a current Member alone.
    const { data, error } = await this.db
      .from('group_members')
      .update({ left_at: at, membership_event_at: at })
      .eq('group_id', t.groupId)
      .eq('line_user_id', t.lineUserId)
      .or(membershipOlderThan(at))
      .select('line_user_id')
    check('markMemberLeft', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  async markMemberJoined(t: { groupId: string; lineUserId: string; at: Date }): Promise<void> {
    const at = t.at.toISOString()
    const { error: addError } = await this.db
      .from('group_members')
      .upsert(
        { group_id: t.groupId, line_user_id: t.lineUserId, source: 'member_join', membership_event_at: at },
        { onConflict: 'group_id,line_user_id', ignoreDuplicates: true },
      )
    check('markMemberJoined', addError)
    // Only a join newer than the last leave or join applied: a late join never undoes a
    // later leave.
    const { error } = await this.db
      .from('group_members')
      .update({ left_at: null, membership_event_at: at })
      .eq('group_id', t.groupId)
      .eq('line_user_id', t.lineUserId)
      .or(membershipOlderThan(at))
    check('markMemberJoined', error)
  }

  async saveGroupSettings(w: GroupSettingsWrite): Promise<{ saved: boolean }> {
    // The Owner check is part of the UPDATE, so an Owner change between the page's check and
    // this write saves nothing.
    const { data, error } = await this.db
      .from('groups')
      .update({
        work_description: w.workDescription,
        feature_summarize: w.features.summarize, feature_draft_tasks: w.features.draftTasks,
        feature_save_files: w.features.saveFiles, feature_track_remind: w.features.trackRemind,
        feature_weekly_summary: w.features.weeklySummary,
        daily_reminder_time: w.dailyReminderTime, weekly_summary_weekday: w.weeklySummaryWeekday,
        weekly_summary_time: w.weeklySummaryTime, tag_set: w.tagSet,
      })
      .eq('id', w.groupId)
      .eq('nominated_owner_line_user_id', w.ownerLineUserId)
      .not('owner_confirmed_at', 'is', null)
      .select('id')
    check('saveGroupSettings', error)
    if ((data?.length ?? 0) === 0) return { saved: false }
    // Up to SETTINGS_MEMBER_WRITES at a time, so a save that touches many Members does not
    // wait through one request after another.
    for (let i = 0; i < w.members.length; i += SETTINGS_MEMBER_WRITES) {
      await Promise.all(w.members.slice(i, i + SETTINGS_MEMBER_WRITES).map(async (m) => {
        const { error: memberError } = await this.db
          .from('group_members')
          .update({ nicknames: m.nicknames, role: m.role })
          .eq('group_id', w.groupId)
          .eq('line_user_id', m.lineUserId)
          .is('left_at', null)
        check('saveGroupSettings', memberError)
      }))
    }
    return { saved: true }
  }

  async setMemberProfile(t: { groupId: string; lineUserId: string; nicknames: string[]; role: string | null }): Promise<{ updated: boolean }> {
    const { data, error } = await this.db
      .from('group_members')
      .update({ nicknames: t.nicknames, role: t.role })
      .eq('group_id', t.groupId)
      .eq('line_user_id', t.lineUserId)
      .is('left_at', null)
      .select('line_user_id')
    check('setMemberProfile', error)
    return { updated: (data?.length ?? 0) > 0 }
  }

  async releaseTasksIfLeft(t: { groupId: string; lineUserId: string }): Promise<TaskRow[]> {
    // One database step (release_tasks_if_left locks the membership row first), so a newer
    // join cannot land between the membership check and the release.
    const { data, error } = await this.db
      .rpc('release_tasks_if_left', { p_group_id: t.groupId, p_line_user_id: t.lineUserId })
      .select(TASK_COLS)
    check('releaseTasksIfLeft', error)
    return ((data ?? []) as unknown as DbTask[]).map(toTaskRow)
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
      ownerNominatedAt: toDate(r.owner_nominated_at), ownerLeftAt: toDate(r.owner_left_at),
      tagSet: r.tag_set ?? [],
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
    // #110: the tag set in a second statement, so setup_group stays as it is; only when the
    // form was saved. A failure is logged: the group simply has no starting tags.
    if ((data === 'confirmed' || data === 'pending') && w.tagSet.length > 0) {
      const tagged = await this.db.from('groups').update({ tag_set: w.tagSet }).eq('id', w.groupId)
      if (tagged.error) logError('group_tag_set_failed', { groupId: w.groupId }, new AdapterError(`supabase saveGroupSetup tag_set: ${tagged.error.code}`))
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

  // ---- #30 the Owner leaves ----
  async markOwnerLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }> {
    // groups_owner_rules clears owner_confirmed_at in the same UPDATE.
    const { data, error } = await this.db
      .from('groups')
      .update({ owner_left_at: t.at.toISOString() })
      .eq('id', t.groupId)
      .eq('nominated_owner_line_user_id', t.lineUserId)
      .not('owner_confirmed_at', 'is', null)
      .select('id')
    check('markOwnerLeft', error)
    return { updated: (data ?? []).length === 1 }
  }

  async openOwnerNeededPrompt(p: { groupId: string; subjectLineUserId: string | null; askedAt: Date }): Promise<{ promptId: string | null }> {
    const { data, error } = await this.db
      .from('task_prompts')
      .insert({
        group_id: p.groupId, kind: 'owner_needed', subject_line_user_id: p.subjectLineUserId,
        asked_at: p.askedAt.toISOString(),
      })
      .select('id')
      .single()
    // 23505 = unique_violation on task_prompts_one_open_owner_needed: the group has an open card.
    if (error?.code === '23505') return { promptId: null }
    check('openOwnerNeededPrompt', error)
    return { promptId: (data as { id: string }).id }
  }

  async listConfirmedOwnersWhoLeft(): Promise<{ groupId: string; lineGroupId: string; lineUserId: string; leftAt: Date }[]> {
    const m = 'listConfirmedOwnersWhoLeft'
    // Groups with a confirmed Owner the bot is still in first (groups_admin_idx), then only
    // their nominees' membership rows: never a scan of every left membership.
    type G = { id: string; line_group_id: string; nominated_owner_line_user_id: string; owner_confirmed_at: string }
    const groups = await readAllPages<G>(m, (from, to) =>
      this.db
        .from('groups')
        .select('id, line_group_id, nominated_owner_line_user_id, owner_confirmed_at')
        .not('owner_confirmed_at', 'is', null)
        .not('nominated_owner_line_user_id', 'is', null)
        .is('left_at', null)
        .order('id')
        .range(from, to))
    const out: { groupId: string; lineGroupId: string; lineUserId: string; leftAt: Date }[] = []
    for (let i = 0; i < groups.length; i += IN_CHUNK) {
      const chunk = groups.slice(i, i + IN_CHUNK)
      const byGroup = new Map(chunk.map((g) => [g.id, g]))
      const rows = await readAllPages<{ group_id: string; line_user_id: string; left_at: string }>(m, (from, to) =>
        this.db
          .from('group_members')
          .select('group_id, line_user_id, left_at')
          .in('group_id', chunk.map((g) => g.id))
          .in('line_user_id', [...new Set(chunk.map((g) => g.nominated_owner_line_user_id))])
          .not('left_at', 'is', null)
          .order('group_id')
          .order('line_user_id')
          .range(from, to))
      for (const r of rows) {
        const g = byGroup.get(r.group_id)
        // The group's own Owner, and only a leave at or after the confirm: an Owner confirmed
        // later (a Sub group taken over by someone who had left it before) has not left since.
        if (!g || g.nominated_owner_line_user_id !== r.line_user_id) continue
        if (Date.parse(r.left_at) < Date.parse(g.owner_confirmed_at)) continue
        out.push({ groupId: g.id, lineGroupId: g.line_group_id, lineUserId: r.line_user_id, leftAt: new Date(r.left_at) })
      }
    }
    return out
  }

  async claimOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerClaimOutcome }> {
    const { data: g, error } = await this.db
      .from('groups')
      .select('is_main, project_id, nominated_owner_line_user_id, owner_confirmed_at, owner_left_at, left_at')
      .eq('id', groupId)
      .maybeSingle()
    check('claimOwnerChange', error)
    const row = g as {
      is_main: boolean; project_id: string | null; nominated_owner_line_user_id: string | null
      owner_confirmed_at: string | null; owner_left_at: string | null; left_at: string | null
    } | null
    if (!row || row.owner_left_at === null || row.owner_confirmed_at !== null || row.left_at !== null) {
      return { outcome: 'not_pending' }
    }
    // A group with no Project (a Sub group detached by #30 part B) is set up afresh.
    const standalone = row.project_id === null
    if (!standalone && !row.is_main) return { outcome: 'not_main_group' }
    const nominee = row.nominated_owner_line_user_id
    if (nominee === lineUserId) return { outcome: 'already_claimed' }
    // The old Owner (or an earlier claimer) who left the group frees the nomination.
    if (nominee !== null && (await this.getMembership(groupId, nominee)) === 'live') return { outcome: 'taken' }
    // Compare-and-set on the nominee read above: of two presses at once, one wins. A new
    // nominee leaves owner_confirmed_at null (groups_owner_rules) and owner_left_at set.
    // Still the same kind of group (is_main implies a Project: groups_main_needs_project).
    const { data: won, error: updateError } = await this.db
      .from('groups')
      .update({
        nominated_owner_line_user_id: lineUserId, owner_nominated_by_line_user_id: lineUserId,
        owner_nominated_at: at.toISOString(),
      })
      .eq('id', groupId)
      .not('owner_left_at', 'is', null)
      .is('owner_confirmed_at', null)
      .filter(standalone ? 'project_id' : 'is_main', standalone ? 'is' : 'eq', standalone ? null : true)
      .filter('nominated_owner_line_user_id', nominee === null ? 'is' : 'eq', nominee)
      .select('id')
    check('claimOwnerChange', updateError)
    if ((won ?? []).length === 1) return { outcome: 'claimed' }
    // Lost the compare-and-set: two presses of the same person at once both read the old
    // nominee, and the other press won. Read again: the winner may be this person.
    const { data: again, error: rereadError } = await this.db
      .from('groups')
      .select('nominated_owner_line_user_id')
      .eq('id', groupId)
      .maybeSingle()
    check('claimOwnerChange', rereadError)
    const now = again as { nominated_owner_line_user_id: string | null } | null
    return { outcome: now?.nominated_owner_line_user_id === lineUserId ? 'already_claimed' : 'taken' }
  }

  async completeOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: CompleteOwnerChangeOutcome }> {
    const { data, error } = await this.db.rpc('complete_owner_change', {
      p_group_id: groupId, p_line_user_id: lineUserId, p_at: at.toISOString(),
    })
    check('completeOwnerChange', error)
    const outcomes: CompleteOwnerChangeOutcome[] = ['changed', 'already_owner', 'not_pending', 'not_nominee', 'not_member', 'needs_drive']
    if (!outcomes.includes(data as CompleteOwnerChangeOutcome)) {
      throw new Error('completeOwnerChange: unexpected result from complete_owner_change')
    }
    return { outcome: data as CompleteOwnerChangeOutcome }
  }

  async answerOwnerNeededPrompt(groupId: string, byLineUserId: string, at: Date): Promise<void> {
    const { error } = await this.db
      .from('task_prompts')
      .update({ answer: 'owner_confirmed', answered_by_line_user_id: byLineUserId, answered_at: at.toISOString() })
      .eq('group_id', groupId)
      .eq('kind', 'owner_needed')
      .is('answer', null)
    check('answerOwnerNeededPrompt', error)
  }

  async listPendingOwnerChanges(lineUserId: string): Promise<string[]> {
    const rows = await readAllPages<{ id: string }>('listPendingOwnerChanges', (from, to) =>
      this.db
        .from('groups')
        .select('id')
        .eq('nominated_owner_line_user_id', lineUserId)
        .or('is_main.eq.true,project_id.is.null')
        .not('owner_left_at', 'is', null)
        .is('owner_confirmed_at', null)
        .is('left_at', null)
        .order('id')
        .range(from, to))
    return rows.map((r) => r.id)
  }

  // ---- #17 Dashboard read ----
  async listDashboardMemberships(lineUserId: string): Promise<DashboardMembership[]> {
    type Row = {
      group_id: string; is_pm: boolean; left_at: string | null
      groups: { project_id: string; projects: { owner_line_user_id: string } }
    }
    // Every page, in a stable order: PostgREST answers at most max_rows (1000) per request,
    // and a left membership missing from the read would let visibleGroups show that group.
    const out: DashboardMembership[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('group_members')
        .select('group_id, is_pm, left_at, groups!inner(project_id, left_at, projects!inner(owner_line_user_id))')
        .eq('line_user_id', lineUserId)
        .not('groups.project_id', 'is', null)
        .is('groups.left_at', null)
        .order('group_id', { ascending: true })
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listDashboardMemberships', error)
      const rows = (data ?? []) as unknown as Row[]
      for (const r of rows) {
        out.push({
          groupId: r.group_id, projectId: r.groups.project_id,
          projectOwnerLineUserId: r.groups.projects.owner_line_user_id, isPm: r.is_pm, left: r.left_at !== null,
        })
      }
      if (rows.length < DASHBOARD_PAGE) return out
    }
  }

  async listUserGroups(lineUserId: string): Promise<UserGroup[]> {
    type Row = { group_id: string; groups: { name: string | null; nominated_owner_line_user_id: string | null; owner_confirmed_at: string | null } }
    const rows = await readAllPages<Row>('listUserGroups', (from, to) =>
      this.db
        .from('group_members')
        .select('group_id, groups!inner(name, left_at, nominated_owner_line_user_id, owner_confirmed_at)')
        .eq('line_user_id', lineUserId)
        .is('left_at', null)
        .is('groups.left_at', null)
        .order('group_id')
        .range(from, to))
    return rows.map((r) => ({
      groupId: r.group_id, name: r.groups.name,
      isOwner: r.groups.owner_confirmed_at !== null && r.groups.nominated_owner_line_user_id === lineUserId,
    }))
  }

  async listProjectGroups(projectIds: string[]): Promise<DashboardGroupRow[]> {
    if (projectIds.length === 0) return []
    type Row = {
      id: string; project_id: string; name: string | null
      nominated_owner_line_user_id: string | null; owner_confirmed_at: string | null
    }
    const out: DashboardGroupRow[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('groups')
        .select('id, project_id, name, nominated_owner_line_user_id, owner_confirmed_at')
        .in('project_id', projectIds)
        .is('left_at', null)
        .order('is_main', { ascending: false })
        .order('joined_at', { ascending: true })
        // joined_at is null until a row's first join (review-followups migration): those
        // sort last, by when the row was stored.
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listProjectGroups', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) {
        out.push({
          groupId: r.id, projectId: r.project_id, name: r.name,
          ownerLineUserId: r.owner_confirmed_at !== null ? r.nominated_owner_line_user_id : null,
        })
      }
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
      due_at: string | null; assignee: { display_name: string | null } | null; tags: string[] | null
    }
    const out: DashboardTaskRow[] = []
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('tasks')
        .select('id, group_id, title, status, assignee_line_user_id, due_at, tags, assignee:line_users!assignee_line_user_id(display_name)')
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
          tags: r.tags ?? [],
        })
      }
      if (rows.length < DASHBOARD_PAGE) return out
    }
  }

  async listLatestWeeklyInsights(groupIds: string[]): Promise<LatestWeeklyInsight[]> {
    if (groupIds.length === 0) return []
    type Row = {
      group_id: string; week_start: string; tasks_done: number; tasks_in_process: number
      tasks_awaiting_owner: number; posted_at: string | null
    }
    // PostgREST has no DISTINCT ON: read every row, newest week first per group, in pages,
    // and keep the first of each group. One row per group and week keeps this small.
    const latest = new Map<string, LatestWeeklyInsight>()
    for (let from = 0; ; from += DASHBOARD_PAGE) {
      const { data, error } = await this.db
        .from('weekly_insights')
        .select('group_id, week_start, tasks_done, tasks_in_process, tasks_awaiting_owner, posted_at')
        .in('group_id', groupIds)
        .order('group_id')
        .order('week_start', { ascending: false })
        .range(from, from + DASHBOARD_PAGE - 1)
      check('listLatestWeeklyInsights', error)
      const rows = (data ?? []) as Row[]
      for (const r of rows) {
        if (latest.has(r.group_id)) continue
        latest.set(r.group_id, {
          groupId: r.group_id, weekStart: r.week_start,
          counts: { done: r.tasks_done, inProcess: r.tasks_in_process, awaitingOwner: r.tasks_awaiting_owner },
          postedAt: toDate(r.posted_at),
        })
      }
      if (rows.length < DASHBOARD_PAGE) return [...latest.values()]
    }
  }

  // ---- #12 Google ----
  async upsertGoogleAccount(a: NewGoogleAccount): Promise<{ id: string }> {
    // refresh_token_ciphertext is text: the sealed 'v1.<iv>.<tag>.<ct>' string as-is.
    // connected_at is written on every sign-in (#14): it orders a person's accounts.
    const { data, error } = await this.db.from('google_accounts').upsert(
      {
        line_user_id: a.lineUserId, google_subject: a.googleSubject, email: a.email,
        granted_scopes: a.grantedScopes, refresh_token_ciphertext: a.refreshTokenCiphertext, token_status: 'valid',
        connected_at: a.signedInAt.toISOString(),
      },
      { onConflict: 'google_subject' },
    ).select('id').maybeSingle()
    check('upsertGoogleAccount', error)
    const row = data as { id: string } | null
    if (!row) throw new AdapterError('supabase upsertGoogleAccount: no row')
    return { id: row.id }
  }

  async findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired'; signedInAt: Date } | null> {
    const { data, error } = await this.db
      .from('google_accounts')
      .select('id, token_status, connected_at')
      .eq('line_user_id', lineUserId)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    check('findGoogleAccountByLineUser', error)
    const row = data as { id: string; token_status: 'valid' | 'revoked' | 'expired'; connected_at: string } | null
    return row ? { id: row.id, tokenStatus: row.token_status, signedInAt: toDate(row.connected_at) } : null
  }

  async findGoogleAccountToken(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired'; refreshTokenCiphertext: string | null } | null> {
    const { data, error } = await this.db
      .from('google_accounts')
      .select('id, token_status, refresh_token_ciphertext')
      .eq('line_user_id', lineUserId)
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    check('findGoogleAccountToken', error)
    const row = data as { id: string; token_status: 'valid' | 'revoked' | 'expired'; refresh_token_ciphertext: string | null } | null
    return row ? { id: row.id, tokenStatus: row.token_status, refreshTokenCiphertext: row.refresh_token_ciphertext } : null
  }

  async markGoogleAccountRevoked(googleAccountId: string, refreshTokenCiphertext: string): Promise<{ revoked: boolean }> {
    const { data, error } = await this.db
      .from('google_accounts')
      .update({ token_status: 'revoked', refresh_token_ciphertext: null })
      .eq('id', googleAccountId)
      .eq('token_status', 'valid')
      .eq('refresh_token_ciphertext', refreshTokenCiphertext)
      .select('id')
    check('markGoogleAccountRevoked', error)
    return { revoked: ((data ?? []) as unknown[]).length > 0 }
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
      // The Owner's latest account (last sign-in), as findGoogleAccountByLineUser.
      this.db
        .from('google_accounts')
        .select('id, token_status, refresh_token_ciphertext, drive_root_folder_id')
        .eq('line_user_id', project.owner_line_user_id)
        .order('connected_at', { ascending: false })
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

  async listDriveConnectedProjects(): Promise<string[]> {
    const rows = await readAllPages<{ project_id: string }>('listDriveConnectedProjects', (from, to) =>
      this.db
        .from('drive_connections')
        .select('project_id')
        .eq('status', 'active')
        .order('id')
        .range(from, to))
    return rows.map((r) => r.project_id)
  }

  async retireDriveConnection(projectId: string, keepGoogleAccountId: string, at: Date): Promise<{ retired: boolean }> {
    const m = 'retireDriveConnection'
    // Separate statements, so what this guarantees is narrow and stated here:
    //  * Only folder IDs read before the active row was read are cleared (the clears match
    //    on those IDs). An ID stored after those reads is never cleared by this call.
    //  * The row is retired last, and only if it is still the active row read at the
    //    start: re-read after the clears, then an UPDATE that matches id and 'active'.
    //  * A call that stops part-way leaves the row active; the same call again finishes.
    // Not guaranteed: a Drive run of the old account that is already under way can still
    // store a folder ID or claim the Project after this call (that needs a holder check
    // inside the folder UPDATE, so a database function).
    const { data: p, error: projectError } = await this.db
      .from('projects')
      .select('drive_project_folder_id')
      .eq('id', projectId)
      .maybeSingle()
    check(m, projectError)
    const projectFolderId = (p as { drive_project_folder_id: string | null } | null)?.drive_project_folder_id ?? null
    const groupFolderIds = (await readAllPages<{ drive_folder_id: string }>(m, (from, to) =>
      this.db
        .from('groups')
        .select('drive_folder_id')
        .eq('project_id', projectId)
        .not('drive_folder_id', 'is', null)
        .order('id')
        .range(from, to))).map((g) => g.drive_folder_id)
    const { data, error } = await this.db
      .from('drive_connections')
      .select('id, google_account_id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle()
    check(m, error)
    const active = data as { id: string; google_account_id: string } | null
    if (!active || active.google_account_id === keepGoogleAccountId) return { retired: false }
    // Cleared first, retired last: until the last statement the row is still active, so a
    // run that stops here is seen and repeated by the next sign-in.
    if (projectFolderId !== null) {
      const { error: clearError } = await this.db
        .from('projects')
        .update({ drive_project_folder_id: null })
        .eq('id', projectId)
        .eq('drive_project_folder_id', projectFolderId)
      check(m, clearError)
    }
    for (const chunk of chunks(groupFolderIds)) {
      const { error: clearError } = await this.db
        .from('groups')
        .update({ drive_folder_id: null })
        .eq('project_id', projectId)
        .in('drive_folder_id', chunk)
      check(m, clearError)
    }
    const { data: again, error: againError } = await this.db
      .from('drive_connections')
      .select('id, google_account_id')
      .eq('project_id', projectId)
      .eq('status', 'active')
      .maybeSingle()
    check(m, againError)
    if ((again as { id: string } | null)?.id !== active.id) return { retired: false }
    const retired = await this.db
      .from('drive_connections')
      .update({ status: 'replaced', status_changed_at: at.toISOString() })
      .eq('id', active.id)
      .eq('status', 'active')
      .select('id')
    check(m, retired.error)
    return { retired: ((retired.data ?? []) as unknown[]).length > 0 }
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

    type Account = { id: string; line_user_id: string; token_status: string; updated_at: string; connected_at: string }
    type Main = { project_id: string; nominated_owner_line_user_id: string; owner_confirmed_at: string }
    const accounts: Account[] = []
    const mains: Main[] = []
    for (const chunk of chunks(owners)) {
      const [a, g] = await Promise.all([
        readAllPages<Account>(m, (x, y) =>
          this.db
            .from('google_accounts')
            .select('id, line_user_id, token_status, updated_at, connected_at')
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

    // Each Owner's latest account (last sign-in), as getDriveContext reads it. The window
    // below still runs on updated_at, which also moves when a root folder ID is stored.
    const latest = new Map<string, Account>()
    for (const a of accounts) {
      const seen = latest.get(a.line_user_id)
      if (!seen || toDate(a.connected_at).getTime() > toDate(seen.connected_at).getTime()) latest.set(a.line_user_id, a)
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

  // ---- #31 Project Owner change ----
  async changeProjectOwner(projectId: string, newOwnerLineUserId: string): Promise<{ outcome: OwnerChangeOutcome }> {
    const { error } = await this.db.rpc('change_project_owner', { p_project_id: projectId, p_new_owner: newOwnerLineUserId })
    // check_violation: the main group does not name this person as its nominee.
    if (error?.code === '23514') return { outcome: 'not_nominee' }
    check('changeProjectOwner', error)
    return { outcome: 'changed' }
  }

  async getOwnerChange(projectId: string): Promise<OwnerChangeState | null> {
    const m = 'getOwnerChange'
    const { data: p, error } = await this.db
      .from('projects')
      .select('id, owner_line_user_id')
      .eq('id', projectId)
      .maybeSingle()
    check(m, error)
    const project = p as { id: string; owner_line_user_id: string } | null
    if (!project) return null
    type Row = {
      id: string; line_group_id: string; name: string | null; is_main: boolean
      nominated_owner_line_user_id: string | null; owner_confirmed_at: string | null; takeover_asked_at: string | null
    }
    const rows = await readAllPages<Row>(m, (from, to) =>
      this.db
        .from('groups')
        .select('id, line_group_id, name, is_main, nominated_owner_line_user_id, owner_confirmed_at, takeover_asked_at')
        .eq('project_id', projectId)
        .order('id')
        .range(from, to))
    const main = rows.find((r) => r.is_main)
    return {
      projectId: project.id,
      ownerLineUserId: project.owner_line_user_id,
      mainGroup: main
        ? {
            groupId: main.id, lineGroupId: main.line_group_id, name: main.name,
            nominatedOwnerLineUserId: main.nominated_owner_line_user_id, ownerConfirmedAt: toDate(main.owner_confirmed_at),
          }
        : null,
      waiting: rows
        .filter((r) => !r.is_main && r.takeover_asked_at !== null)
        .map((r) => ({ groupId: r.id, lineGroupId: r.line_group_id, name: r.name, askedAt: toDate(r.takeover_asked_at) as Date })),
    }
  }

  async answerSubgroupTakeover(projectId: string, takeoverGroupIds: string[]): Promise<{ outcome: TakeoverAnswerOutcome }> {
    const { error } = await this.db.rpc('answer_subgroup_takeover', {
      p_project_id: projectId, p_takeover_group_ids: takeoverGroupIds,
    })
    // check_violation: a chosen Sub group is no longer waiting (the daily rule detached it).
    // serialization_failure: the groups changed while the answer was saved. Nothing was written.
    if (error?.code === '23514' || error?.code === '40001') return { outcome: 'changed' }
    // NJ409: the question waited more than 7 days (20261116010000). Nothing was written.
    if (error?.code === 'NJ409') return { outcome: 'expired' }
    check('answerSubgroupTakeover', error)
    return { outcome: 'saved' }
  }

  async detachExpiredTakeovers(askedBefore: Date, at: Date): Promise<DetachedSubGroup[]> {
    // The documented daily statement (initial schema, change_project_owner):
    //   update groups set project_id = null, takeover_asked_at = null
    //    where takeover_asked_at < <cutoff> returning ...
    // project_id and takeover_asked_at change together (groups_takeover_pending_rules).
    // #30 part B, in the same SET: a waiting Sub group has no confirmed Owner, so it starts a
    // fresh Owner count with no nominee. The WHERE never moves owner_left_at back: a group
    // whose owner_left_at is newer (a re-invite since this tick began) detaches on a later tick.
    // The folder ID pointed into the old Owner's Drive (#74-4).
    const when = at.toISOString()
    const { data, error } = await this.db
      .from('groups')
      .update({ project_id: null, takeover_asked_at: null, drive_folder_id: null, ...OWNER_COUNT(when) })
      .lt('takeover_asked_at', askedBefore.toISOString())
      .or(`owner_left_at.is.null,owner_left_at.lt.${when}`)
      .select('id, line_group_id, name')
    check('detachExpiredTakeovers', error)
    return ((data ?? []) as { id: string; line_group_id: string; name: string | null }[])
      .map((r) => ({ groupId: r.id, lineGroupId: r.line_group_id, name: r.name }))
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
  }

  async startDetachedOwnerCount(groupIds: string[], at: Date): Promise<string[]> {
    if (groupIds.length === 0) return []
    type Row = {
      id: string; project_id: string | null; owner_confirmed_at: string | null
      owner_left_at: string | null; owner_nominated_at: string | null
    }
    const { data, error } = await this.db
      .from('groups')
      .select('id, project_id, owner_confirmed_at, owner_left_at, owner_nominated_at')
      .in('id', groupIds)
    check('startDetachedOwnerCount', error)
    const out: string[] = []
    for (const r of (data ?? []) as Row[]) {
      if (!ownerCountDue(r, at)) continue
      // Compare-and-set on what was read, so a claim landing in between is kept.
      const { data: done, error: updateError } = await this.db
        .from('groups')
        .update(OWNER_COUNT(at.toISOString()))
        .eq('id', r.id)
        .is('project_id', null)
        .is('owner_confirmed_at', null)
        .filter('owner_left_at', r.owner_left_at === null ? 'is' : 'eq', r.owner_left_at)
        .filter('owner_nominated_at', r.owner_nominated_at === null ? 'is' : 'eq', r.owner_nominated_at)
        .select('id')
      check('startDetachedOwnerCount', updateError)
      if ((done ?? []).length === 1) out.push(r.id)
    }
    return out.sort()
  }

  async listUnsentTakeoverCards(askedAfter: Date): Promise<{ projectId: string; askedAt: Date }[]> {
    const m = 'listUnsentTakeoverCards'
    const waiting = await readAllPages<{ project_id: string; takeover_asked_at: string }>(m, (from, to) =>
      this.db
        .from('groups')
        .select('project_id, takeover_asked_at')
        .gte('takeover_asked_at', askedAfter.toISOString())
        .order('id')
        .range(from, to))
    // change_project_owner asks every Sub group at once: the earliest ask names the question.
    const askedAt = new Map<string, number>()
    for (const w of waiting) {
      const t = Date.parse(w.takeover_asked_at)
      askedAt.set(w.project_id, Math.min(askedAt.get(w.project_id) ?? t, t))
    }
    if (askedAt.size === 0) return []
    const projectIds = [...askedAt.keys()].sort()
    const mains = await readAllPages<{ project_id: string; line_group_id: string }>(m, (from, to) =>
      this.db
        .from('groups')
        .select('project_id, line_group_id')
        .in('project_id', projectIds)
        .eq('is_main', true)
        .order('id')
        .range(from, to))
    if (mains.length === 0) return []
    const since = Math.min(...askedAt.values())
    const pushes = await readAllPages<{ line_target_id: string; sent_at: string }>(m, (from, to) =>
      this.db
        .from('push_log')
        .select('line_target_id, sent_at')
        .eq('purpose', 'owner_takeover')
        .in('line_target_id', mains.map((g) => g.line_group_id))
        .gte('sent_at', new Date(since).toISOString())
        .order('id')
        .range(from, to))
    const mainOf = new Map(mains.map((g) => [g.project_id, g.line_group_id]))
    return projectIds
      .filter((id) => {
        const target = mainOf.get(id)
        if (target === undefined) return false
        const asked = askedAt.get(id) as number
        return !pushes.some((p) => p.line_target_id === target && Date.parse(p.sent_at) >= asked)
      })
      .map((id) => ({ projectId: id, askedAt: new Date(askedAt.get(id) as number) }))
  }

  async listPausedOwnerCards(): Promise<PausedOwnerCard[]> {
    const m = 'listPausedOwnerCards'
    // groups_owner_left_idx serves this filter.
    type G = { id: string; line_group_id: string; nominated_owner_line_user_id: string | null }
    const groups = await readAllPages<G>(m, (from, to) =>
      this.db
        .from('groups')
        .select('id, line_group_id, nominated_owner_line_user_id')
        .not('owner_left_at', 'is', null)
        .is('owner_confirmed_at', null)
        .is('left_at', null)
        .order('id')
        .range(from, to))
    const out: PausedOwnerCard[] = []
    for (let i = 0; i < groups.length; i += IN_CHUNK) {
      const chunk = groups.slice(i, i + IN_CHUNK)
      const prompts = await readAllPages<{ id: string; group_id: string; asked_at: string }>(m, (from, to) =>
        this.db
          .from('task_prompts')
          .select('id, group_id, asked_at')
          .eq('kind', 'owner_needed')
          .is('answer', null)
          .in('group_id', chunk.map((g) => g.id))
          .order('id')
          .range(from, to))
      const promptOf = new Map(prompts.map((p) => [p.group_id, p]))
      const opened = prompts.map((p) => Date.parse(p.asked_at))
      const pushes = opened.length === 0 ? [] : await readAllPages<{ line_target_id: string; sent_at: string }>(m, (from, to) =>
        this.db
          .from('push_log')
          .select('line_target_id, sent_at')
          .eq('purpose', 'owner_needed')
          .in('line_target_id', chunk.filter((g) => promptOf.has(g.id)).map((g) => g.line_group_id))
          .gte('sent_at', new Date(Math.min(...opened)).toISOString())
          .order('id')
          .range(from, to))
      for (const g of chunk) {
        const p = promptOf.get(g.id)
        const askedAt = p ? Date.parse(p.asked_at) : 0
        out.push({
          groupId: g.id, lineGroupId: g.line_group_id, ownerLineUserId: g.nominated_owner_line_user_id,
          card: p
            ? {
                promptId: p.id, askedAt: new Date(askedAt),
                pushed: pushes.some((x) => x.line_target_id === g.line_group_id && Date.parse(x.sent_at) >= askedAt),
              }
            : null,
        })
      }
    }
    return out
  }

  // ---- #11 removal and recovery ----
  async markBotLeft(m: { lineGroupId: string; at: Date }): Promise<{ deleteAfter: Date | null }> {
    const at = m.at.toISOString()
    // Only an unmarked group, and only a leave newer than the latest join applied.
    const { error } = await this.db
      .from('groups')
      .update({ left_at: at, delete_after: new Date(m.at.getTime() + BOT_DELETE_AFTER_MS).toISOString() })
      .eq('line_group_id', m.lineGroupId)
      .is('left_at', null)
      // joined_at null: no join applied to this row yet (20261116010000), so any leave counts.
      .or(`joined_at.is.null,joined_at.lte."${at}"`)
    check('markBotLeft', error)
    const read = await this.db.from('groups').select('delete_after').eq('line_group_id', m.lineGroupId).maybeSingle()
    check('markBotLeft', read.error)
    const row = read.data as { delete_after: string | null } | null
    return { deleteAfter: row ? toDate(row.delete_after) : null }
  }

  async getGroupDeleteAfter(groupId: string): Promise<Date | null> {
    const { data, error } = await this.db.from('groups').select('delete_after').eq('id', groupId).maybeSingle()
    check('getGroupDeleteAfter', error)
    const row = data as { delete_after: string | null } | null
    return row ? toDate(row.delete_after) : null
  }

  async markBotJoined(j: { groupId: string; at: Date }): Promise<void> {
    const at = j.at.toISOString()
    // The 7-day Owner count starts again while no Owner is confirmed (#30). First, so a
    // redelivery after a half-failure still reaches it.
    const owner = await this.db
      .from('groups')
      .update({ owner_left_at: at })
      .eq('id', j.groupId)
      .is('owner_confirmed_at', null)
      .lt('owner_left_at', at)
    check('markBotJoined', owner.error)
    // The first join of a row sets joined_at to the event's time (null until then); later
    // joins only move it forward.
    const joined = await this.db.from('groups').update({ joined_at: at }).eq('id', j.groupId)
      .or(`joined_at.is.null,joined_at.lt."${at}"`)
    check('markBotJoined', joined.error)
    const cleared = await this.db
      .from('groups')
      .update({ left_at: null, delete_after: null })
      .eq('id', j.groupId)
      .lte('left_at', at)
    check('markBotJoined', cleared.error)
  }

  async listOwnerlessGroups(leftBefore: Date, limit: number): Promise<OwnerlessGroup[]> {
    const { data, error } = await this.db
      .from('groups')
      .select('id, line_group_id, project_id, is_main, nominated_owner_line_user_id, owner_left_at, joined_at')
      .lte('owner_left_at', leftBefore.toISOString())
      .is('owner_confirmed_at', null)
      .is('left_at', null)
      .order('owner_left_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit)
    check('listOwnerlessGroups', error)
    type Row = {
      id: string; line_group_id: string; project_id: string | null; is_main: boolean
      nominated_owner_line_user_id: string | null; owner_left_at: string; joined_at: string | null
    }
    return ((data ?? []) as Row[]).map((r) => ({
      groupId: r.id, lineGroupId: r.line_group_id, subGroup: r.project_id !== null && !r.is_main,
      nominatedOwnerLineUserId: r.nominated_owner_line_user_id,
      ownerLeftAt: toDate(r.owner_left_at), joinedAt: toDate(r.joined_at),
    }))
  }

  async getOwnerExitState(groupId: string): Promise<OwnerExitState | null> {
    const { data, error } = await this.db
      .from('groups')
      .select('project_id, is_main, owner_confirmed_at, owner_left_at, left_at, joined_at, owner_nominated_at')
      .eq('id', groupId)
      .maybeSingle()
    check('getOwnerExitState', error)
    const r = data as {
      project_id: string | null; is_main: boolean; owner_confirmed_at: string | null
      owner_left_at: string | null; left_at: string | null; joined_at: string | null; owner_nominated_at: string | null
    } | null
    if (!r) return null
    return {
      ownerConfirmedAt: toDate(r.owner_confirmed_at), ownerLeftAt: toDate(r.owner_left_at),
      leftAt: toDate(r.left_at), joinedAt: toDate(r.joined_at), subGroup: r.project_id !== null && !r.is_main,
      ownerNominatedAt: toDate(r.owner_nominated_at),
    }
  }

  async detachOwnerlessSubGroup(groupId: string, leftBefore: Date, at: Date): Promise<{ detached: boolean }> {
    // project_id and takeover_asked_at change together (groups_takeover_pending_rules), as in
    // detachExpiredTakeovers (#31).
    const { data, error } = await this.db
      .from('groups')
      .update({ project_id: null, takeover_asked_at: null, drive_folder_id: null, ...OWNER_COUNT(at.toISOString()) })
      .eq('id', groupId)
      .not('project_id', 'is', null)
      .eq('is_main', false)
      .is('owner_confirmed_at', null)
      .lte('owner_left_at', leftBefore.toISOString())
      .is('left_at', null)
      .select('id')
    check('detachOwnerlessSubGroup', error)
    return { detached: (data ?? []).length === 1 }
  }

  async listPurgeDueGroups(now: Date, limit: number): Promise<string[]> {
    const { data, error } = await this.db
      .from('groups')
      .select('id')
      .lte('delete_after', now.toISOString())
      .order('delete_after', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit)
    check('listPurgeDueGroups', error)
    return ((data ?? []) as { id: string }[]).map((r) => r.id)
  }

  async purgeGroup(groupId: string, now: Date): Promise<{ purged: boolean }> {
    // The due check is part of the DELETE: a group re-invited since it was listed stays.
    const { data, error } = await this.db
      .from('groups')
      .delete()
      .eq('id', groupId)
      .lte('delete_after', now.toISOString())
      .select('id')
    check('purgeGroup', error)
    return { purged: (data ?? []).length > 0 }
  }
}
