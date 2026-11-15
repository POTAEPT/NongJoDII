import { randomUUID } from 'node:crypto'
import type {
  AiUsageActual,
  AiUsageCap,
  AnnounceClaim,
  CandidateRow,
  CandidateState,
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
  NewAiUsage,
  NewCandidate,
  NewGoogleAccount,
  NewMessage,
  NewSummary,
  NewTask,
  NewProgressPrompt,
  NewWebhookEvent,
  OwnerChangeOutcome,
  PausedOwnerCard,
  OwnerClaimOutcome,
  OwnerlessGroup,
  OwnerExitState,
  OwnerConfirmOutcome,
  PushBudgetClaim,
  NewWeeklyInsight,
  DailyReminderGroup,
  MemberCheckGroup,
  DriveContext,
  DriveGroup,
  DashboardFileRow,
  NewFile,
  SavedFile,
  DetachedSubGroup,
  CompleteOwnerChangeOutcome,
  OwnerChangeState,
  TakeoverAnswerOutcome,
  ReminderTask,
  MessageRef,
  QuotedFileLookup,
  ProgressPromptRow,
  SetupOutcome,
  StorePort,
  StoredMessage,
  SummaryRow,
  TaskCounts,
  TaskPatch,
  TaskRow,
  UnownedTask,
  WeeklySummaryGroup,
  ProgressYes,
  ProgressYesOutcome,
} from '@/server/ports'
import { bangkokMonthRange } from '@/server/time/bangkok'

// In-memory StorePort. Tables mirror supabase/migrations/ (camelCase columns,
// only the columns the app uses) and enforce the same unique keys and FKs.
// Store-once methods mirror INSERT ... ON CONFLICT (<target>) DO NOTHING RETURNING.
// Every method checks everything before it writes, so a throw changes nothing.

export type LineUserRecord = { lineUserId: string; displayName: string | null }
export type GroupMemberRecord = {
  groupId: string; lineUserId: string; nicknames: string[]; role: string | null
  source: 'message' | 'liff' | 'setup_form' | 'member_join'; leftAt: Date | null
  isPm?: boolean // group_members.is_pm; absent = false
  /** Time of the latest memberLeft or memberJoined event applied; absent or null when none. */
  membershipEventAt?: Date | null
  /** group_members.member_checked_on (#32): Bangkok date of the last daily check; absent = null. */
  memberCheckedOn?: string | null
}

/** Same rule as SupabaseStore's membershipOlderThan. */
function membershipOlderThan(row: GroupMemberRecord, at: Date): boolean {
  const last = row.membershipEventAt ?? row.leftAt
  return last === null || last < at
}
export type MessageRecord = NewMessage & {
  id: string
  progressDismissedAt?: Date | null; progressDismissedByLineUserId?: string | null // #7 picker dismissed
}
export type SummaryRecord = NewSummary & { id: string }
export type CandidateRecord = CandidateRow & {
  decidedByLineUserId: string | null; decidedAt: Date | null; createdAt: Date
}
export type TaskRecord = Omit<TaskRow, 'lineGroupId'> & {
  lastEditedByLineUserId: string | null; lastActivityAt: Date | null; doneAt: Date | null
  /** #23: who soft-deleted it ("ไม่ใช่งาน"); absent = never set. */
  deletedByLineUserId?: string | null
  announcePendingToken: string | null; announcePendingAt: Date | null
}
export type PushLogRecord = { id: string; purpose: string; lineTargetId: string; messageCount: number; sentAt: Date }
/** task_prompts, kind mark_done only (the kind #7 writes). */
export type ProgressPromptRecord = ProgressPromptRow
export type AiUsageRecord = NewAiUsage & { id: string; settledAt: Date | null } // settledAt null = open claim
export type FairUseNoticeRecord = { ownerLineUserId: string; groupId: string; monthStartBkk: string; kind: 'warn_80' }
export type GoogleAccountRecord = {
  id: string; lineUserId: string; googleSubject: string; email: string | null; grantedScopes: string[]
  refreshTokenCiphertext: string | null; tokenStatus: 'valid' | 'revoked' | 'expired'
  driveRootFolderId?: string | null   // absent = null (#13)
  updatedAt: Date                     // set on every write, like the table's trigger
  signedInAt?: Date                   // google_accounts.connected_at: the last sign-in (#14)
}
/** public.files (#4 writes it; #33 reads it). */
export type FileRecord = {
  id: string; groupId: string; messageId: string | null; fileName: string; driveLink: string; savedAt: Date
  senderLineUserId: string | null; driveConnectionId: string; contentSha256: string; driveFileId: string
  sentAt: Date; sizeBytes: number | null
}
export type ImageSetCardRecord = { groupId: string; imageSetId: string; claimedAt: Date }
export type DriveConnectionRecord = {
  id: string; projectId: string; googleAccountId: string; status: 'active' | 'replaced'
  statusChangedAt?: Date | null   // absent = null; set when the row is retired (#14)
}

/** The groups columns the weekly insight reads (left_at, feature_weekly_summary and the
 *  weekly slot), kept beside `groups` so GroupRow stays as the app reads it. A group with
 *  no row here has the schema defaults: bot in, feature on, Monday 09:00, never sent. */
export type GroupScheduleRecord = {
  groupId: string; leftAt: Date | null; featureWeeklySummary: boolean
  weeklySummaryWeekday: number; weeklySummaryTime: string; weeklySummaryLastSentOn: string | null
  dailyReminderTime: string; dailyReminderLastSentOn: string | null
  /** groups.daily_reminder_claimed_at: the live attempt's claim, or null. */
  dailyReminderClaimedAt?: Date | null
  /** groups.member_check_on and member_check_claimed_at (#32); absent = null. */
  memberCheckOn?: string | null
  memberCheckClaimedAt?: Date | null
  /** #11: groups.delete_after (left_at + 7 days) and groups.joined_at (absent = null: no
   *  join applied to the row yet, the review-followups migration). Absent = null.
   *  groups.owner_left_at lives on GroupRow (`groups`). */
  deleteAfter?: Date | null
  joinedAt?: Date | null
}
export type WeeklyInsightRecord = NewWeeklyInsight & { id: string; postedAt: Date | null }
/** The other groups columns setup writes (#52). No row = schema defaults. */
export type GroupSetupRecord = {
  groupId: string; isMain: boolean; featureSaveFiles: boolean
  ownerNominatedByLineUserId: string | null; ownerNominatedAt: Date | null
  driveFolderId?: string | null   // groups.drive_folder_id; absent = null (#13)
  takeoverAskedAt?: Date | null   // groups.takeover_asked_at; absent = null (#31, set by change_project_owner)
}
/** task_prompts rows of kind owner_needed (#30). */
export type OwnerPromptRecord = {
  id: string; groupId: string; subjectLineUserId: string | null; askedAt: Date
  answer: 'owner_confirmed' | null; answeredByLineUserId: string | null; answeredAt: Date | null
}
export type ProjectRecord = { id: string; ownerLineUserId: string; driveProjectFolderId?: string | null }

export type FakeTables = {
  line_users: LineUserRecord[]
  groups: GroupRow[]
  group_members: GroupMemberRecord[]
  webhook_events: NewWebhookEvent[]
  messages: MessageRecord[]
  summaries: SummaryRecord[]
  task_candidates: CandidateRecord[]
  tasks: TaskRecord[]
  push_log: PushLogRecord[]
  task_prompts: ProgressPromptRecord[]
  ai_usage: AiUsageRecord[]
  fair_use_notices: FairUseNoticeRecord[]
  google_accounts: GoogleAccountRecord[]
  group_schedules: GroupScheduleRecord[]
  weekly_insights: WeeklyInsightRecord[]
  group_setups: GroupSetupRecord[]
  projects: ProjectRecord[]
  drive_connections: DriveConnectionRecord[]
  owner_prompts: OwnerPromptRecord[]
  files: FileRecord[]
  image_set_cards: ImageSetCardRecord[]
}

const SEED_NOW = new Date('2026-11-12T03:00:00Z')

function fk(ok: boolean, column: string): void {
  if (!ok) throw new Error(`FK violation: ${column}`)
}

function unique(clash: boolean, column: string): void {
  if (clash) throw new Error(`unique violation: ${column}`)
}

export class FakeStore implements StorePort {
  tables: FakeTables = {
    line_users: [],
    groups: [],
    group_members: [],
    webhook_events: [],
    messages: [],
    summaries: [],
    task_candidates: [],
    tasks: [],
    push_log: [],
    task_prompts: [],
    ai_usage: [],
    fair_use_notices: [],
    google_accounts: [],
    group_schedules: [],
    weekly_insights: [],
    group_setups: [],
    projects: [],
    drive_connections: [],
    owner_prompts: [],
    files: [],
    image_set_cards: [],
  }

  /** The database's now(), for columns it stamps itself (google_accounts.updated_at).
   *  makeTestDeps sets it to the harness clock. */
  clock: () => Date = () => new Date(SEED_NOW.getTime())

  /** Test aid (#13): every claim and every Project or group folder ID write, in call
   *  order, whether or not the compare-and-set matched. */
  driveWrites: (
    | { op: 'claim'; projectId: string; accountId: string; holder: string }
    | { op: 'project'; projectId: string; to: string }
    | { op: 'group'; groupId: string; to: string }
  )[] = []

  /** unsent_messages: LINE message IDs whose sender unsent them (#24). */
  unsentLineMessageIds = new Set<string>()
  /** group_members writes made by saveGroupSettings: one database request each in SupabaseStore. */
  settingsMemberWrites = 0
  private faults: { method: keyof StorePort; err: Error; skip: number }[] = []
  // Sign-in order of google_accounts rows (ORDER BY connected_at DESC), kept as a sequence
  // because tests sign several accounts in at the same clock time.
  private googleSignIns = new Map<string, number>()
  private googleSignInSeq = 0

  /** Fault injection: skips `after` calls of `method` (default 0), then the next one rejects. */
  failNext(method: keyof StorePort, err?: Error, opts?: { after?: number }): void {
    this.faults.push({ method, err: err ?? new Error(`FakeStore: injected failure in ${method}`), skip: opts?.after ?? 0 })
  }

  private fault(method: keyof StorePort): void {
    const i = this.faults.findIndex((f) => f.method === method)
    if (i === -1) return
    const f = this.faults[i]
    if (f.skip > 0) {
      f.skip--
      return
    }
    this.faults.splice(i, 1)
    throw f.err
  }

  // ---- lookups used for FK checks ----
  private hasLineUser(id: string | null): boolean {
    return id === null || this.tables.line_users.some((u) => u.lineUserId === id)
  }
  private hasGroup(id: string | null): boolean {
    return id === null || this.tables.groups.some((g) => g.id === id)
  }
  private groupOf(id: string): GroupRow {
    const g = this.tables.groups.find((row) => row.id === id)
    if (!g) throw new Error(`FakeStore: group ${id} vanished`)
    return g
  }
  private ensureLineUserRow(lineUserId: string | null): void {
    if (lineUserId !== null && !this.hasLineUser(lineUserId)) {
      this.tables.line_users.push({ lineUserId, displayName: null })
    }
  }

  // ---- #1 webhook ----
  async recordWebhookEvent(e: NewWebhookEvent): Promise<{ inserted: boolean }> {
    this.fault('recordWebhookEvent')
    if (this.tables.webhook_events.some((w) => w.webhookEventId === e.webhookEventId)) return { inserted: false }
    this.tables.webhook_events.push({ ...e })
    return { inserted: true }
  }

  async hasWebhookEvent(webhookEventId: string): Promise<boolean> {
    this.fault('hasWebhookEvent')
    return this.tables.webhook_events.some((w) => w.webhookEventId === webhookEventId)
  }

  async upsertLineUser(u: { lineUserId: string; displayName: string | null }): Promise<void> {
    this.fault('upsertLineUser')
    const existing = this.tables.line_users.find((row) => row.lineUserId === u.lineUserId)
    if (!existing) {
      this.tables.line_users.push({ ...u })
    } else if (u.displayName !== null) {
      existing.displayName = u.displayName
    }
  }

  async findLineUser(lineUserId: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    this.fault('findLineUser')
    const row = this.tables.line_users.find((u) => u.lineUserId === lineUserId)
    return row ? { ...row } : null
  }

  async ensureGroup(lineGroupId: string): Promise<GroupRow> {
    this.fault('ensureGroup')
    let row = this.tables.groups.find((g) => g.lineGroupId === lineGroupId)
    if (!row) {
      row = {
        id: randomUUID(), lineGroupId, projectId: null, name: null,
        nominatedOwnerLineUserId: null, ownerConfirmedAt: null,
        featureSummarize: true, featureDraftTasks: true, workDescription: null, featureTrackRemind: true,
        ownerLeftAt: null,
      }
      this.tables.groups.push(row)
    }
    return { ...row }
  }

  async getGroupById(groupId: string): Promise<GroupRow | null> {
    this.fault('getGroupById')
    const row = this.tables.groups.find((g) => g.id === groupId)
    return row ? { ...row } : null
  }

  async touchGroupMember(groupId: string, lineUserId: string, source: 'message' | 'liff'): Promise<void> {
    this.fault('touchGroupMember')
    if (this.tables.group_members.some((m) => m.groupId === groupId && m.lineUserId === lineUserId)) return
    fk(this.hasGroup(groupId), 'group_members.group_id')
    fk(this.hasLineUser(lineUserId), 'group_members.line_user_id')
    this.tables.group_members.push({ groupId, lineUserId, nicknames: [], role: null, source, leftAt: null })
  }

  async getMembership(groupId: string, lineUserId: string): Promise<Membership> {
    this.fault('getMembership')
    const row = this.tables.group_members.find((m) => m.groupId === groupId && m.lineUserId === lineUserId)
    if (!row) return 'none'
    return row.leftAt === null ? 'live' : 'left'
  }

  async insertMessage(m: NewMessage): Promise<{ inserted: boolean; id: string | null }> {
    this.fault('insertMessage')
    // Conflict target first: a redelivery is a no-op, whatever else it carries.
    if (this.tables.messages.some((row) => row.webhookEventId === m.webhookEventId)) return { inserted: false, id: null }
    // messages_skip_unsent: the sender unsent this message, so a late delivery stores nothing.
    if (this.unsentLineMessageIds.has(m.lineMessageId)) return { inserted: false, id: null }
    unique(this.tables.messages.some((row) => row.lineMessageId === m.lineMessageId), 'messages.line_message_id')
    fk(this.hasGroup(m.groupId), 'messages.group_id')
    fk(this.tables.webhook_events.some((w) => w.webhookEventId === m.webhookEventId), 'messages.webhook_event_id')
    fk(this.hasLineUser(m.senderLineUserId), 'messages.sender_line_user_id')
    const id = randomUUID()
    this.tables.messages.push({ ...m, id })
    return { inserted: true, id }
  }

  // ---- #15 Summary ----
  async listRecentTextMessages(groupId: string, limit: number): Promise<StoredMessage[]> {
    this.fault('listRecentTextMessages')
    return this.tables.messages
      .filter((m) => m.groupId === groupId && m.messageType === 'text' && m.text !== null)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .reverse()
      .map((m) => ({
        id: m.id,
        senderLineUserId: m.senderLineUserId,
        senderDisplayName:
          this.tables.line_users.find((u) => u.lineUserId === m.senderLineUserId)?.displayName ?? null,
        text: m.text as string,
        sentAt: m.sentAt,
        mentions: m.mentions,
      }))
  }

  async listLiveMembers(groupId: string): Promise<Member[]> {
    this.fault('listLiveMembers')
    return this.tables.group_members
      .filter((m) => m.groupId === groupId && m.leftAt === null)
      .map((m) => ({
        lineUserId: m.lineUserId,
        displayName: this.tables.line_users.find((u) => u.lineUserId === m.lineUserId)?.displayName ?? null,
        nicknames: [...m.nicknames],
        role: m.role,
      }))
  }

  async createSummary(s: NewSummary, candidates: NewCandidate[]): Promise<{ summaryId: string; candidateIds: string[] }> {
    this.fault('createSummary')
    fk(this.hasGroup(s.groupId), 'summaries.group_id')
    fk(this.hasLineUser(s.requestedByLineUserId), 'summaries.requested_by_line_user_id')
    for (const c of candidates) {
      fk(this.hasLineUser(c.suggestedAssigneeLineUserId), 'task_candidates.suggested_assignee_line_user_id')
    }
    const summaryId = randomUUID()
    this.tables.summaries.push({ ...s, id: summaryId })
    const candidateIds = candidates.map((c, i) => {
      const id = randomUUID()
      this.tables.task_candidates.push({
        ...c, id, summaryId, state: 'proposed', decidedByLineUserId: null, decidedAt: null,
        createdAt: new Date(s.createdAt.getTime() + i),
      })
      return id
    })
    return { summaryId, candidateIds }
  }

  // ---- #16 confirm / edit ----
  async getSummary(summaryId: string): Promise<SummaryRow | null> {
    this.fault('getSummary')
    const s = this.tables.summaries.find((row) => row.id === summaryId)
    if (!s) return null
    return {
      id: s.id, groupId: s.groupId, lineGroupId: this.groupOf(s.groupId).lineGroupId,
      summaryText: s.summaryText, createdAt: s.createdAt,
    }
  }

  async listCandidates(summaryId: string): Promise<CandidateRow[]> {
    this.fault('listCandidates')
    return this.tables.task_candidates
      .filter((c) => c.summaryId === summaryId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({
        id: c.id, summaryId: c.summaryId, state: c.state, title: c.title, details: c.details,
        suggestedAssigneeLineUserId: c.suggestedAssigneeLineUserId, suggestedDueAt: c.suggestedDueAt,
      }))
  }

  async decideCandidate(
    candidateId: string, state: 'confirmed' | 'declined', decidedBy: string, decidedAt: Date,
  ): Promise<{ updated: boolean }> {
    this.fault('decideCandidate')
    const c = this.tables.task_candidates.find((row) => row.id === candidateId)
    if (!c || c.state !== ('proposed' satisfies CandidateState)) return { updated: false }
    fk(this.hasLineUser(decidedBy), 'task_candidates.decided_by_line_user_id')
    c.state = state
    c.decidedByLineUserId = decidedBy
    c.decidedAt = decidedAt
    return { updated: true }
  }

  async confirmCandidate(
    t: NewTask, decidedAt: Date,
  ): Promise<{ outcome: 'created' | 'already_decided'; taskId: string | null }> {
    this.fault('confirmCandidate')
    // Same rules as the confirm_candidate function, applied as one step.
    const c = this.tables.task_candidates.find((row) => row.id === t.candidateId)
    if (!c) throw new Error(`FakeStore: unknown candidate ${t.candidateId}`)
    if (c.state === 'declined') return { outcome: 'already_decided', taskId: null }
    const existing = this.tables.tasks.find((row) => row.candidateId === t.candidateId)
    if (!existing) this.checkTaskFks(t)
    if (c.state === 'proposed') fk(this.hasLineUser(t.createdByLineUserId), 'task_candidates.decided_by_line_user_id')
    let taskId = existing?.id
    if (!taskId) {
      taskId = randomUUID()
      this.tables.tasks.push({
        ...t, id: taskId, deletedAt: null, announcedAt: null, lastEditedByLineUserId: null, lastActivityAt: null, doneAt: null,
        announcePendingToken: null, announcePendingAt: null,
      })
    }
    if (c.state === 'proposed') {
      c.state = 'confirmed'
      c.decidedByLineUserId = t.createdByLineUserId
      c.decidedAt = decidedAt
    }
    return { outcome: existing ? 'already_decided' : 'created', taskId }
  }

  private checkTaskFks(t: Pick<TaskRecord, 'groupId' | 'candidateId' | 'assigneeLineUserId' | 'createdByLineUserId'>): void {
    fk(this.hasGroup(t.groupId), 'tasks.group_id')
    fk(t.candidateId === null || this.tables.task_candidates.some((c) => c.id === t.candidateId), 'tasks.candidate_id')
    fk(this.hasLineUser(t.assigneeLineUserId), 'tasks.assignee_line_user_id')
    fk(this.hasLineUser(t.createdByLineUserId), 'tasks.created_by_line_user_id')
  }

  private toTaskRow(t: TaskRecord): TaskRow {
    return {
      id: t.id, groupId: t.groupId, lineGroupId: this.groupOf(t.groupId).lineGroupId, candidateId: t.candidateId,
      title: t.title, details: t.details, status: t.status, assigneeLineUserId: t.assigneeLineUserId,
      createdByLineUserId: t.createdByLineUserId, dueAt: t.dueAt, deletedAt: t.deletedAt, announcedAt: t.announcedAt,
    }
  }

  async getTask(taskId: string): Promise<TaskRow | null> {
    this.fault('getTask')
    const t = this.tables.tasks.find((row) => row.id === taskId)
    return t ? this.toTaskRow(t) : null
  }

  // Mirrors SupabaseStore: the same statements in the same order, with no await
  // between them, so each claim is atomic like the database statements.
  async claimTaskAnnouncements(c: AnnounceClaim): Promise<{ taskId: string; token: string }[]> {
    this.fault('claimTaskAnnouncements')
    const open = (t: TaskRecord) => t.announcedAt === null && t.deletedAt === null
    const tokens = new Set(this.tables.tasks
      .filter((t) => c.taskIds.includes(t.id) && open(t) && t.announcePendingToken !== null)
      .map((t) => t.announcePendingToken as string))
    const out: { taskId: string; token: string }[] = []
    const inBatch = (t: TaskRecord) => open(t) && t.announcePendingToken !== null && tokens.has(t.announcePendingToken)
    const released = this.tables.tasks.filter((t) => inBatch(t) && t.announcePendingAt === null)
    for (const t of released) t.announcePendingAt = c.at
    const stale = this.tables.tasks.filter((t) => inBatch(t) && t.announcePendingAt !== null && t.announcePendingAt < c.staleBefore)
    for (const t of stale) t.announcePendingAt = c.at
    for (const t of [...released, ...stale]) out.push({ taskId: t.id, token: t.announcePendingToken as string })
    const fresh = this.tables.tasks.filter((t) => c.taskIds.includes(t.id) && open(t) && t.announcePendingToken === null)
    for (const t of fresh) {
      t.announcePendingToken = c.token
      t.announcePendingAt = c.at
      out.push({ taskId: t.id, token: c.token })
    }
    return out
  }

  async confirmTaskAnnouncements(token: string, at: Date): Promise<void> {
    this.fault('confirmTaskAnnouncements')
    for (const t of this.tables.tasks) {
      if (t.announcePendingToken !== token || t.announcedAt !== null) continue
      t.announcedAt = at
      t.announcePendingToken = null
      t.announcePendingAt = null
    }
  }

  private heldBy(t: TaskRecord, token: string, claimedAt: Date): boolean {
    return t.announcePendingToken === token && t.announcePendingAt?.getTime() === claimedAt.getTime() && t.announcedAt === null
  }

  async releaseTaskAnnouncements(token: string, claimedAt: Date): Promise<void> {
    this.fault('releaseTaskAnnouncements')
    for (const t of this.tables.tasks) if (this.heldBy(t, token, claimedAt)) t.announcePendingAt = null
  }

  async abandonTaskAnnouncements(token: string, claimedAt: Date): Promise<void> {
    this.fault('abandonTaskAnnouncements')
    for (const t of this.tables.tasks) {
      if (!this.heldBy(t, token, claimedAt)) continue
      t.announcePendingToken = null
      t.announcePendingAt = null
    }
  }

  /** Clock for push_log rows (the database uses now()); tests may move it. */
  pushClock: () => Date = () => new Date()

  // Mirrors claim_push_budget: rows of the last 10 minutes count on top of lineUsed.
  async claimPushBudget(c: PushBudgetClaim): Promise<{ pushLogId: string | null }> {
    this.fault('claimPushBudget')
    const now = this.pushClock()
    const recent = this.tables.push_log
      .filter((p) => p.sentAt.getTime() > now.getTime() - 10 * 60_000)
      .reduce((sum, p) => sum + p.messageCount, 0)
    if (c.lineUsed + recent + c.messageCount > c.allowed) return { pushLogId: null }
    const id = randomUUID()
    this.tables.push_log.push({ id, purpose: c.purpose, lineTargetId: c.lineTargetId, messageCount: c.messageCount, sentAt: now })
    return { pushLogId: id }
  }

  async releasePushBudget(pushLogId: string): Promise<void> {
    this.fault('releasePushBudget')
    this.tables.push_log = this.tables.push_log.filter((p) => p.id !== pushLogId)
  }

  async listTasksByCandidates(candidateIds: string[]): Promise<TaskRow[]> {
    this.fault('listTasksByCandidates')
    return this.tables.tasks
      .filter((t) => t.candidateId !== null && candidateIds.includes(t.candidateId))
      .map((t) => this.toTaskRow(t))
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<{ updated: boolean }> {
    this.fault('updateTask')
    const t = this.tables.tasks.find((row) => row.id === taskId && row.deletedAt === null)
    if (!t) return { updated: false }
    fk(this.hasLineUser(patch.assigneeLineUserId), 'tasks.assignee_line_user_id')
    fk(this.hasLineUser(patch.lastEditedByLineUserId), 'tasks.last_edited_by_line_user_id')
    Object.assign(t, patch)
    return { updated: true }
  }

  // ---- #7 Track progress ----
  async listOpenTasks(groupId: string): Promise<TaskRow[]> {
    this.fault('listOpenTasks')
    return this.tables.tasks
      .filter((t) => t.groupId === groupId && t.deletedAt === null && t.status !== 'done')
      .map((t) => this.toTaskRow(t))
  }

  // ---- #24 unsend ----
  async unsendMessage(lineMessageId: string): Promise<{ deleted: boolean }> {
    this.fault('unsendMessage')
    // unsent_messages tombstone, as rpc unsend_message
    this.unsentLineMessageIds.add(lineMessageId)
    const i = this.tables.messages.findIndex((row) => row.lineMessageId === lineMessageId)
    if (i === -1) return { deleted: false }
    const [gone] = this.tables.messages.splice(i, 1)
    // task_prompts.trigger_message_id is ON DELETE SET NULL.
    for (const p of this.tables.task_prompts) if (p.triggerMessageId === gone.id) p.triggerMessageId = null
    // files.message_id is ON DELETE SET NULL too: the saved file stays.
    for (const f of this.tables.files) if (f.messageId === gone.id) f.messageId = null
    return { deleted: true }
  }

  // ---- #4 file saver ----
  private toSavedFile(f: FileRecord): SavedFile {
    return {
      id: f.id, groupId: f.groupId, messageId: f.messageId, fileName: f.fileName, driveLink: f.driveLink,
      driveFileId: f.driveFileId, sizeBytes: f.sizeBytes,
    }
  }

  async findFileByHash(groupId: string, contentSha256: string): Promise<SavedFile | null> {
    this.fault('findFileByHash')
    const f = this.tables.files.find((r) => r.groupId === groupId && r.contentSha256 === contentSha256)
    return f ? this.toSavedFile(f) : null
  }

  /** ON CONFLICT (group_id, content_sha256) DO NOTHING, plus the FKs and the
   *  files_check_drive_connection trigger (the connection is active and of the group's Project). */
  async insertFile(f: NewFile): Promise<{ inserted: boolean; file: SavedFile }> {
    this.fault('insertFile')
    const clash = this.tables.files.find((r) => r.groupId === f.groupId && r.contentSha256 === f.contentSha256)
    if (clash) return { inserted: false, file: this.toSavedFile(clash) }
    fk(this.hasGroup(f.groupId), 'files.group_id')
    fk(this.tables.messages.some((m) => m.id === f.messageId), 'files.message_id')
    fk(this.hasLineUser(f.senderLineUserId), 'files.sender_line_user_id')
    const conn = this.tables.drive_connections.find((c) => c.id === f.driveConnectionId)
    fk(conn !== undefined, 'files.drive_connection_id')
    if (conn?.projectId !== this.groupOf(f.groupId).projectId) throw new Error('check_violation: file Drive connection must belong to the Project')
    if (conn?.status !== 'active') throw new Error('check_violation: file Drive connection must be active')
    const row: FileRecord = { id: randomUUID(), ...f }
    this.tables.files.push(row)
    return { inserted: true, file: this.toSavedFile(row) }
  }

  async linkFileToMessage(fileId: string, messageId: string): Promise<{ updated: boolean }> {
    this.fault('linkFileToMessage')
    const f = this.tables.files.find((r) => r.id === fileId)
    if (!f) return { updated: false }
    fk(this.tables.messages.some((m) => m.id === messageId), 'files.message_id')
    f.messageId = messageId
    return { updated: true }
  }

  async findActiveDriveConnection(projectId: string): Promise<{ id: string; googleAccountId: string } | null> {
    this.fault('findActiveDriveConnection')
    const c = this.tables.drive_connections.find((r) => r.projectId === projectId && r.status === 'active')
    return c ? { id: c.id, googleAccountId: c.googleAccountId } : null
  }

  async countImageSet(groupId: string, imageSetId: string): Promise<{ messages: number; saved: number }> {
    this.fault('countImageSet')
    const ids = this.tables.messages.filter((m) => m.groupId === groupId && m.imageSetId === imageSetId).map((m) => m.id)
    const saved = ids.filter((id) => this.tables.files.some((f) => f.messageId === id)).length
    return { messages: ids.length, saved }
  }

  async claimImageSetCard(groupId: string, imageSetId: string): Promise<{ claimed: boolean }> {
    this.fault('claimImageSetCard')
    if (this.tables.image_set_cards.some((c) => c.groupId === groupId && c.imageSetId === imageSetId)) return { claimed: false }
    fk(this.hasGroup(groupId), 'image_set_cards.group_id')
    this.tables.image_set_cards.push({ groupId, imageSetId, claimedAt: this.clock() })
    return { claimed: true }
  }

  async listDashboardFiles(groupIds: string[], limit: number): Promise<DashboardFileRow[]> {
    this.fault('listDashboardFiles')
    return groupIds.flatMap((groupId) => this.tables.files
      .filter((f) => f.groupId === groupId)
      .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime() || (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map((f) => ({
        id: f.id, groupId: f.groupId, fileName: f.fileName, driveLink: f.driveLink, sizeBytes: f.sizeBytes,
        savedAt: f.savedAt,
        senderName: this.tables.line_users.find((u) => u.lineUserId === f.senderLineUserId)?.displayName ?? null,
      })))
  }

  // ---- #33 file request ----
  async findQuotedFile(groupId: string, lineMessageId: string): Promise<QuotedFileLookup> {
    this.fault('findQuotedFile')
    const m = this.tables.messages.find((row) => row.groupId === groupId && row.lineMessageId === lineMessageId)
    if (!m) return { kind: 'no_message' }
    const newest = this.tables.files
      .filter((f) => f.messageId === m.id)
      .sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime() || (a.id < b.id ? 1 : -1))[0]
    return newest ? { kind: 'file', fileName: newest.fileName, driveLink: newest.driveLink } : { kind: 'no_file' }
  }

  async getMessageRef(messageId: string): Promise<MessageRef | null> {
    this.fault('getMessageRef')
    const m = this.tables.messages.find((row) => row.id === messageId)
    return m
      ? { id: m.id, groupId: m.groupId, senderLineUserId: m.senderLineUserId, sentAt: m.sentAt, progressDismissedAt: m.progressDismissedAt ?? null }
      : null
  }

  async dismissProgressPicker(messageId: string, byLineUserId: string, at: Date): Promise<{ updated: boolean }> {
    this.fault('dismissProgressPicker')
    const m = this.tables.messages.find((row) => row.id === messageId && !row.progressDismissedAt)
    if (!m) return { updated: false }
    fk(this.hasLineUser(byLineUserId), 'messages.progress_dismissed_by_line_user_id')
    m.progressDismissedAt = at
    m.progressDismissedByLineUserId = byLineUserId
    return { updated: true }
  }

  async findOpenProgressPrompt(taskId: string): Promise<ProgressPromptRow | null> {
    this.fault('findOpenProgressPrompt')
    const p = this.tables.task_prompts.find((row) => row.taskId === taskId && row.answer === null)
    return p ? { ...p } : null
  }

  async createProgressPrompt(n: NewProgressPrompt): Promise<{ prompt: ProgressPromptRow | null }> {
    this.fault('createProgressPrompt')
    // Unique index task_prompts_one_open_mark_done.
    if (this.tables.task_prompts.some((row) => row.taskId === n.taskId && row.answer === null)) return { prompt: null }
    fk(this.hasGroup(n.groupId), 'task_prompts.group_id')
    fk(this.tables.tasks.some((t) => t.id === n.taskId), 'task_prompts.task_id')
    fk(this.hasLineUser(n.subjectLineUserId), 'task_prompts.subject_line_user_id')
    fk(n.triggerMessageId === null || this.tables.messages.some((m) => m.id === n.triggerMessageId), 'task_prompts.trigger_message_id')
    const row: ProgressPromptRecord = { ...n, id: randomUUID(), answer: null, answeredByLineUserId: null, answeredAt: null }
    this.tables.task_prompts.push(row)
    return { prompt: { ...row } }
  }

  async getProgressPrompt(promptId: string): Promise<ProgressPromptRow | null> {
    this.fault('getProgressPrompt')
    const p = this.tables.task_prompts.find((row) => row.id === promptId)
    return p ? { ...p } : null
  }

  async answerProgressPrompt(promptId: string, answer: 'no', byLineUserId: string, at: Date): Promise<{ updated: boolean }> {
    this.fault('answerProgressPrompt')
    const p = this.tables.task_prompts.find((row) => row.id === promptId && row.answer === null)
    if (!p) return { updated: false }
    fk(this.hasLineUser(byLineUserId), 'task_prompts.answered_by_line_user_id')
    Object.assign(p, { answer, answeredByLineUserId: byLineUserId, answeredAt: at })
    return { updated: true }
  }

  // Same rules as the answer_progress_yes function, applied as one step: every check
  // runs before any write, so a throw changes nothing.
  async confirmProgressYes(y: ProgressYes): Promise<{ outcome: ProgressYesOutcome }> {
    this.fault('confirmProgressYes')
    const p = this.tables.task_prompts.find((row) => row.id === y.promptId && row.taskId === y.taskId)
    if (!p) return { outcome: 'task_changed' }
    if (p.answer !== null) return { outcome: 'already_answered' }
    // The presser must still be the Task's assignee or the card's subject at write time.
    const t = this.tables.tasks.find((row) => row.id === y.taskId && row.deletedAt === null && row.status === y.fromStatus
      && (row.assigneeLineUserId === y.byLineUserId || p.subjectLineUserId === y.byLineUserId))
    if (!t) return { outcome: 'task_changed' }
    fk(this.hasLineUser(y.byLineUserId), 'tasks.last_edited_by_line_user_id')
    fk(this.hasLineUser(y.assignTo), 'tasks.assignee_line_user_id')
    t.status = y.toStatus
    if (y.toStatus === 'done') t.doneAt = y.at
    if (y.assignTo !== null) t.assigneeLineUserId = y.assignTo
    t.lastEditedByLineUserId = y.byLineUserId
    t.lastActivityAt = y.at
    Object.assign(p, { answer: 'yes', answeredByLineUserId: y.byLineUserId, answeredAt: y.at })
    return { outcome: 'updated' }
  }

  async withdrawProgressPrompt(promptId: string): Promise<void> {
    this.fault('withdrawProgressPrompt')
    this.tables.task_prompts = this.tables.task_prompts.filter((row) => !(row.id === promptId && row.answer === null))
  }

  // ---- #5 / #6 usage ----
  // Mirrors claim_ai_usage: the sum and the insert run with no await between them, so
  // concurrent claims are serialized like the per-Owner advisory lock, and a claim
  // sees every earlier claim (open or settled).
  async claimAiUsage(u: NewAiUsage, cap: AiUsageCap): Promise<{ claimId: string | null }> {
    this.fault('claimAiUsage')
    fk(this.hasLineUser(u.ownerLineUserId), 'ai_usage.owner_line_user_id')
    fk(this.hasGroup(u.groupId), 'ai_usage.group_id')
    const used = this.sumMonth(u.ownerLineUserId, bangkokMonthRange(u.createdAt).monthStartBkk)
    if (used.tokens >= cap.capTokens || used.costMicroUsd >= Math.round(cap.capCostUsd * 1e6)) return { claimId: null }
    const id = randomUUID()
    this.tables.ai_usage.push({ ...u, id, settledAt: null })
    return { claimId: id }
  }

  async settleAiUsage(claimId: string, actual: AiUsageActual): Promise<void> {
    this.fault('settleAiUsage')
    const row = this.tables.ai_usage.find((r) => r.id === claimId)
    if (!row) throw new Error('FakeStore: settleAiUsage claim not found')
    Object.assign(row, actual, { settledAt: row.settledAt ?? row.createdAt })
  }

  async releaseAiUsage(claimId: string): Promise<void> {
    this.fault('releaseAiUsage')
    this.tables.ai_usage = this.tables.ai_usage.filter((r) => !(r.id === claimId && r.settledAt === null))
  }

  async sumOwnerMonthUsage(ownerLineUserId: string, monthStart: string): Promise<{ tokens: number; costMicroUsd: number }> {
    this.fault('sumOwnerMonthUsage')
    return this.sumMonth(ownerLineUserId, monthStart)
  }

  private sumMonth(ownerLineUserId: string, monthStart: string): { tokens: number; costMicroUsd: number } {
    const rows = this.tables.ai_usage.filter(
      (u) => u.ownerLineUserId === ownerLineUserId && bangkokMonthRange(u.createdAt).monthStartBkk === monthStart,
    )
    const tokens = rows.reduce((sum, u) => sum + u.inputTokens + u.outputTokens, 0)
    const costUsd = rows.reduce((sum, u) => sum + u.costUsd, 0)
    return { tokens, costMicroUsd: Math.round(costUsd * 1e6) }
  }

  async claimFairUseNotice(n: FairUseNoticeRecord): Promise<{ inserted: boolean }> {
    this.fault('claimFairUseNotice')
    const clash = this.tables.fair_use_notices.some(
      (row) => row.ownerLineUserId === n.ownerLineUserId && row.groupId === n.groupId &&
        row.monthStartBkk === n.monthStartBkk && row.kind === n.kind,
    )
    if (clash) return { inserted: false }
    this.tables.fair_use_notices.push({ ...n })
    return { inserted: true }
  }

  // ---- #17 Dashboard read ----
  async listDashboardMemberships(lineUserId: string): Promise<DashboardMembership[]> {
    this.fault('listDashboardMemberships')
    return this.tables.group_members
      .filter((m) => m.lineUserId === lineUserId)
      .flatMap((m) => {
        const g = this.tables.groups.find((row) => row.id === m.groupId)
        const project = g?.projectId ? this.tables.projects.find((p) => p.id === g.projectId) : undefined
        const botLeft = this.tables.group_schedules.find((r) => r.groupId === m.groupId)?.leftAt ?? null
        // groups inner join: only groups in a Project (with its row) that still have the bot
        if (!g || !g.projectId || !project || botLeft !== null) return []
        return [{
          groupId: m.groupId, projectId: g.projectId, projectOwnerLineUserId: project.ownerLineUserId,
          isPm: m.isPm === true, left: m.leftAt !== null,
        }]
      })
  }

  async listUserGroups(lineUserId: string): Promise<UserGroup[]> {
    this.fault('listUserGroups')
    return this.tables.group_members
      .filter((m) => m.lineUserId === lineUserId && m.leftAt === null)
      .flatMap((m) => {
        const g = this.tables.groups.find((row) => row.id === m.groupId)
        const botLeft = this.tables.group_schedules.find((r) => r.groupId === m.groupId)?.leftAt ?? null
        if (!g || botLeft !== null) return []
        return [{ groupId: g.id, name: g.name, isOwner: g.ownerConfirmedAt !== null && g.nominatedOwnerLineUserId === lineUserId }]
      })
      .sort((a, b) => a.groupId.localeCompare(b.groupId))
  }

  async listProjectGroups(projectIds: string[]): Promise<DashboardGroupRow[]> {
    this.fault('listProjectGroups')
    const isMain = (id: string) => this.tables.group_setups.find((r) => r.groupId === id)?.isMain === true
    const rows = this.tables.groups
      .map((g, order) => ({ g, order }))
      .filter(({ g }) => g.projectId !== null && projectIds.includes(g.projectId))
      .filter(({ g }) => (this.tables.group_schedules.find((r) => r.groupId === g.id)?.leftAt ?? null) === null)
    // main group first, then insertion order (the fake's join order)
    rows.sort((a, b) => Number(isMain(b.g.id)) - Number(isMain(a.g.id)) || a.order - b.order)
    return rows.map(({ g }) => ({ groupId: g.id, projectId: g.projectId as string, name: g.name }))
  }

  async listDashboardMembers(groupIds: string[]): Promise<DashboardMemberRow[]> {
    this.fault('listDashboardMembers')
    return this.tables.group_members
      .filter((m) => groupIds.includes(m.groupId) && m.leftAt === null)
      .map((m) => ({
        groupId: m.groupId, lineUserId: m.lineUserId,
        displayName: this.tables.line_users.find((u) => u.lineUserId === m.lineUserId)?.displayName ?? null,
      }))
  }

  async listDashboardTasks(groupIds: string[]): Promise<DashboardTaskRow[]> {
    this.fault('listDashboardTasks')
    return this.tables.tasks
      .filter((t) => groupIds.includes(t.groupId) && t.deletedAt === null)
      .map((t) => ({
        id: t.id, groupId: t.groupId, title: t.title, status: t.status, assigneeLineUserId: t.assigneeLineUserId,
        assigneeName: this.tables.line_users.find((u) => u.lineUserId === t.assigneeLineUserId)?.displayName ?? null,
        dueAt: t.dueAt,
      }))
  }

  // ---- #12 Google ----
  async upsertGoogleAccount(a: NewGoogleAccount): Promise<{ id: string }> {
    this.fault('upsertGoogleAccount')
    fk(this.hasLineUser(a.lineUserId), 'google_accounts.line_user_id')
    let row = this.tables.google_accounts.find((g) => g.googleSubject === a.googleSubject)
    if (row) {
      Object.assign(row, { ...a, grantedScopes: [...a.grantedScopes], tokenStatus: 'valid', signedInAt: new Date(a.signedInAt.getTime()) })
    } else {
      row = {
        ...a, grantedScopes: [...a.grantedScopes], id: randomUUID(), tokenStatus: 'valid', updatedAt: this.clock(),
        signedInAt: new Date(a.signedInAt.getTime()),
      }
      this.tables.google_accounts.push(row)
    }
    this.touchGoogleAccount(row)
    this.googleSignIns.set(row.id, ++this.googleSignInSeq) // connected_at = this sign-in
    return { id: row.id }
  }

  /** What the google_accounts_updated_at trigger does on every write (the column default on
   *  insert): updated_at = now(). It never changes which account signed in last. */
  private touchGoogleAccount(row: GoogleAccountRecord): void {
    row.updatedAt = this.clock()
  }

  /** The person's latest Google account: the last one to sign in (ORDER BY connected_at DESC). */
  private latestGoogleAccount(lineUserId: string | null): GoogleAccountRecord | undefined {
    return this.tables.google_accounts
      .filter((g) => g.lineUserId === lineUserId)
      .sort((a, b) => (this.googleSignIns.get(b.id) ?? 0) - (this.googleSignIns.get(a.id) ?? 0))[0]
  }

  /** A user with several Google accounts gets the one that signed in last. */
  async findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired'; signedInAt: Date } | null> {
    this.fault('findGoogleAccountByLineUser')
    const row = this.latestGoogleAccount(lineUserId)
    return row ? { id: row.id, tokenStatus: row.tokenStatus, signedInAt: new Date((row.signedInAt ?? row.updatedAt).getTime()) } : null
  }

  /** The conditional UPDATE: only a 'valid' row that still holds this token changes. */
  async markGoogleAccountRevoked(googleAccountId: string, refreshTokenCiphertext: string): Promise<{ revoked: boolean }> {
    this.fault('markGoogleAccountRevoked')
    const row = this.tables.google_accounts.find((a) => a.id === googleAccountId)
    if (!row || row.tokenStatus !== 'valid' || row.refreshTokenCiphertext !== refreshTokenCiphertext) return { revoked: false }
    row.tokenStatus = 'revoked'
    row.refreshTokenCiphertext = null
    this.touchGoogleAccount(row)
    return { revoked: true }
  }

  // ---- #13 Drive folders ----
  private isLeft(groupId: string): boolean {
    return this.tables.group_schedules.find((s) => s.groupId === groupId)?.leftAt != null
  }
  private isMainGroup(groupId: string): boolean {
    return this.tables.group_setups.find((r) => r.groupId === groupId)?.isMain === true
  }

  /** Ordered by group id, as SupabaseStore pages it. */
  async listConfirmedOwnerProjects(lineUserId: string): Promise<string[]> {
    this.fault('listConfirmedOwnerProjects')
    return this.tables.groups
      .filter((g) => g.projectId !== null && this.isMainGroup(g.id) && g.nominatedOwnerLineUserId === lineUserId &&
        g.ownerConfirmedAt !== null && !this.isLeft(g.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((g) => g.projectId as string)
  }

  async getDriveContext(projectId: string): Promise<DriveContext | null> {
    this.fault('getDriveContext')
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (!project) return null
    const groups = this.tables.groups
      .filter((g) => g.projectId === projectId && g.ownerConfirmedAt !== null && !this.isLeft(g.id))
      .sort((a, b) => a.id.localeCompare(b.id))
    const toDrive = (g: GroupRow): DriveGroup => ({
      groupId: g.id, lineGroupId: g.lineGroupId, name: g.name,
      folderId: this.tables.group_setups.find((r) => r.groupId === g.id)?.driveFolderId ?? null,
    })
    const main = groups.find((g) => this.isMainGroup(g.id))
    const account = this.latestGoogleAccount(project.ownerLineUserId)
    const active = this.tables.drive_connections.find((c) => c.projectId === projectId && c.status === 'active')
    return {
      projectId, ownerLineUserId: project.ownerLineUserId, projectFolderId: project.driveProjectFolderId ?? null,
      mainGroup: main ? toDrive(main) : null,
      subGroups: groups.filter((g) => !this.isMainGroup(g.id)).map(toDrive),
      account: account
        ? {
            id: account.id, tokenStatus: account.tokenStatus,
            refreshTokenCiphertext: account.refreshTokenCiphertext, rootFolderId: account.driveRootFolderId ?? null,
          }
        : null,
      activeAccountId: active?.googleAccountId ?? null,
    }
  }

  async setDriveRootFolder(googleAccountId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    this.fault('setDriveRootFolder')
    const row = this.tables.google_accounts.find((a) => a.id === googleAccountId)
    if (!row) return { folderId: null }
    if ((row.driveRootFolderId ?? null) === from) {
      row.driveRootFolderId = to
      this.touchGoogleAccount(row) // an UPDATE: the trigger moves updated_at
    }
    return { folderId: row.driveRootFolderId ?? null }
  }

  async setProjectDriveFolder(projectId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    this.fault('setProjectDriveFolder')
    this.driveWrites.push({ op: 'project', projectId, to })
    const row = this.tables.projects.find((p) => p.id === projectId)
    if (!row) return { folderId: null }
    if ((row.driveProjectFolderId ?? null) === from) row.driveProjectFolderId = to
    return { folderId: row.driveProjectFolderId ?? null }
  }

  async setGroupDriveFolder(groupId: string, from: string | null, to: string): Promise<{ folderId: string | null }> {
    this.fault('setGroupDriveFolder')
    this.driveWrites.push({ op: 'group', groupId, to })
    if (!this.hasGroup(groupId)) return { folderId: null }
    const row = this.setupOf(groupId)
    if ((row.driveFolderId ?? null) === from) row.driveFolderId = to
    return { folderId: row.driveFolderId ?? null }
  }

  /** One active row per Project, as the unique index drive_connections_one_active: a
   *  second claim answers the account that already holds it. */
  async claimDriveConnection(projectId: string, googleAccountId: string): Promise<{ created: boolean; accountId: string }> {
    this.fault('claimDriveConnection')
    fk(this.tables.projects.some((p) => p.id === projectId), 'drive_connections.project_id')
    fk(this.tables.google_accounts.some((a) => a.id === googleAccountId), 'drive_connections.google_account_id')
    const held = this.tables.drive_connections.find((c) => c.projectId === projectId && c.status === 'active')
    const result = held
      ? { created: false, accountId: held.googleAccountId }
      : { created: true, accountId: googleAccountId }
    if (!held) this.tables.drive_connections.push({ id: randomUUID(), projectId, googleAccountId, status: 'active' })
    this.driveWrites.push({ op: 'claim', projectId, accountId: googleAccountId, holder: result.accountId })
    return result
  }

  /** Ordered by connection id, as SupabaseStore pages it. */
  async listDriveConnectedProjects(): Promise<string[]> {
    this.fault('listDriveConnectedProjects')
    return this.tables.drive_connections
      .filter((c) => c.status === 'active')
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => c.projectId)
  }

  /** Test aid (#14): the next retireDriveConnection throws after its clears and before it
   *  retires the row, as when the real store's last statements fail. */
  failRetireAfterClear = false
  private retireHold: { parked(): void; gate: Promise<void> } | null = null

  /** Test aid (#14) for two overlapping changes: the next retireDriveConnection waits after
   *  its reads, before its first write, until `release()`. `reached` resolves once it waits. */
  holdRetire(): { reached: Promise<void>; release(): void } {
    let release = () => {}
    let parked = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reached = new Promise<void>((resolve) => { parked = resolve })
    this.retireHold = { parked, gate }
    return { reached, release }
  }

  /** The same steps in the same order as SupabaseStore: read the folder IDs, read the
   *  active row, clear only the IDs read, read the active row again, retire it. */
  async retireDriveConnection(projectId: string, keepGoogleAccountId: string, at: Date): Promise<{ retired: boolean }> {
    this.fault('retireDriveConnection')
    const activeRow = () => this.tables.drive_connections.find((c) => c.projectId === projectId && c.status === 'active')
    const setups = () => this.tables.groups
      .filter((g) => g.projectId === projectId)
      .map((g) => this.tables.group_setups.find((r) => r.groupId === g.id))
      .filter((r): r is GroupSetupRecord => r !== undefined)
    const project = this.tables.projects.find((p) => p.id === projectId)
    const projectFolderId = project?.driveProjectFolderId ?? null
    const groupFolderIds = setups().map((r) => r.driveFolderId ?? null).filter((id): id is string => id !== null)
    const active = activeRow()
    if (!active || active.googleAccountId === keepGoogleAccountId) return { retired: false }
    const hold = this.retireHold
    if (hold) {
      this.retireHold = null
      hold.parked()
      await hold.gate
    }
    // Compare-and-set clears: only the IDs read above.
    if (project && projectFolderId !== null && project.driveProjectFolderId === projectFolderId) project.driveProjectFolderId = null
    for (const r of setups()) {
      if (r.driveFolderId != null && groupFolderIds.includes(r.driveFolderId)) r.driveFolderId = null
    }
    if (this.failRetireAfterClear) {
      this.failRetireAfterClear = false
      throw new Error('FakeStore: injected failure in retireDriveConnection after the clears')
    }
    const again = activeRow()
    if (!again || again.id !== active.id) return { retired: false }
    again.status = 'replaced'
    again.statusChangedAt = new Date(at.getTime())
    return { retired: true }
  }

  /** Same rule as SupabaseStore, read straight from the tables. */
  async listUnfinishedDriveProjects(from: Date, to: Date): Promise<string[]> {
    this.fault('listUnfinishedDriveProjects')
    return this.tables.groups
      .filter((g) => g.projectId !== null && this.isMainGroup(g.id) && g.ownerConfirmedAt !== null && !this.isLeft(g.id))
      .filter((g) => {
        const account = this.latestGoogleAccount(g.nominatedOwnerLineUserId)
        if (account?.tokenStatus !== 'valid' || g.ownerConfirmedAt === null) return false
        const last = Math.max(g.ownerConfirmedAt.getTime(), account.updatedAt.getTime())
        if (last < from.getTime() || last > to.getTime()) return false
        const held = this.tables.drive_connections.find((c) => c.projectId === g.projectId && c.status === 'active')
        if (held && held.googleAccountId !== account.id) return false
        return this.missesAFolder(g.projectId as string)
      })
      .map((g) => g.projectId as string)
      .sort()
  }

  /** The Project folder ID, or the folder ID of a group getDriveContext lists (confirmed
   *  Owner, bot still in it), is still empty. */
  private missesAFolder(projectId: string): boolean {
    if (!this.tables.projects.find((p) => p.id === projectId)?.driveProjectFolderId) return true
    return this.tables.groups.some((g) => g.projectId === projectId && g.ownerConfirmedAt !== null && !this.isLeft(g.id) &&
      !this.tables.group_setups.find((r) => r.groupId === g.id)?.driveFolderId)
  }

  // ---- #20 weekly insight ----
  /** The schedule row of a group, created with the schema defaults on first use. */
  private scheduleOf(groupId: string): GroupScheduleRecord {
    let row = this.tables.group_schedules.find((s) => s.groupId === groupId)
    if (!row) {
      fk(this.hasGroup(groupId), 'groups.id')
      row = {
        groupId, leftAt: null, featureWeeklySummary: true,
        weeklySummaryWeekday: 1, weeklySummaryTime: '09:00:00', weeklySummaryLastSentOn: null,
        dailyReminderTime: '09:00:00', dailyReminderLastSentOn: null,
      }
      this.tables.group_schedules.push(row)
    }
    return row
  }

  private liveTasksOf(groupId: string): TaskRecord[] {
    return this.tables.tasks.filter((t) => t.groupId === groupId && t.deletedAt === null)
  }

  async listWeeklySummaryGroups(weekday: number): Promise<WeeklySummaryGroup[]> {
    this.fault('listWeeklySummaryGroups')
    return this.tables.groups
      .filter((g) => g.projectId !== null && g.ownerLeftAt === null && g.ownerConfirmedAt !== null)
      .map((g) => ({ g, s: this.scheduleOf(g.id) }))
      .filter(({ s }) => s.leftAt === null && s.featureWeeklySummary && s.weeklySummaryWeekday === weekday)
      .sort((a, b) => a.g.id.localeCompare(b.g.id))
      .map(({ g, s }) => ({
        groupId: g.id, lineGroupId: g.lineGroupId, weekday: s.weeklySummaryWeekday,
        time: s.weeklySummaryTime, lastSentOn: s.weeklySummaryLastSentOn,
      }))
  }

  async claimWeeklySummary(groupId: string, todayBkk: string): Promise<{ claimed: boolean }> {
    this.fault('claimWeeklySummary')
    if (!this.hasGroup(groupId)) return { claimed: false }
    const s = this.scheduleOf(groupId)
    if (s.weeklySummaryLastSentOn !== null && s.weeklySummaryLastSentOn >= todayBkk) return { claimed: false }
    s.weeklySummaryLastSentOn = todayBkk
    return { claimed: true }
  }

  async releaseWeeklySummary(groupId: string, todayBkk: string, previous: string | null): Promise<void> {
    this.fault('releaseWeeklySummary')
    const s = this.tables.group_schedules.find((row) => row.groupId === groupId)
    if (s && s.weeklySummaryLastSentOn === todayBkk) s.weeklySummaryLastSentOn = previous
  }

  async countTasksByStatus(groupId: string): Promise<TaskCounts> {
    this.fault('countTasksByStatus')
    const live = this.liveTasksOf(groupId)
    return {
      done: live.filter((t) => t.status === 'done').length,
      inProcess: live.filter((t) => t.status === 'in_process').length,
      awaitingOwner: live.filter((t) => t.status === 'not_assigned').length,
    }
  }

  /** Oldest first = seed/insert order (the fake keeps no created_at on tasks). */
  async listUnownedTasks(groupId: string, limit: number): Promise<UnownedTask[]> {
    this.fault('listUnownedTasks')
    return this.liveTasksOf(groupId)
      .filter((t) => t.status === 'not_assigned')
      .slice(0, limit)
      .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt }))
  }

  async listLatestWeeklyInsights(groupIds: string[]): Promise<LatestWeeklyInsight[]> {
    this.fault('listLatestWeeklyInsights')
    const latest = new Map<string, WeeklyInsightRecord>()
    for (const w of this.tables.weekly_insights) {
      if (!groupIds.includes(w.groupId)) continue
      const seen = latest.get(w.groupId)
      if (!seen || w.weekStart > seen.weekStart) latest.set(w.groupId, w)
    }
    return [...latest.values()].map((w) => ({ groupId: w.groupId, weekStart: w.weekStart, counts: { ...w.counts }, postedAt: w.postedAt }))
  }

  async saveWeeklyInsight(i: NewWeeklyInsight): Promise<{ inserted: boolean }> {
    this.fault('saveWeeklyInsight')
    if (this.tables.weekly_insights.some((w) => w.groupId === i.groupId && w.weekStart === i.weekStart)) {
      return { inserted: false }
    }
    fk(this.hasGroup(i.groupId), 'weekly_insights.group_id')
    this.tables.weekly_insights.push({ ...i, counts: { ...i.counts }, id: randomUUID(), postedAt: null })
    return { inserted: true }
  }

  async hasWeeklyInsight(groupId: string, weekStart: string): Promise<boolean> {
    this.fault('hasWeeklyInsight')
    return this.tables.weekly_insights.some((w) => w.groupId === groupId && w.weekStart === weekStart)
  }

  async markWeeklyInsightPosted(groupId: string, weekStart: string, at: Date): Promise<void> {
    this.fault('markWeeklyInsightPosted')
    const row = this.tables.weekly_insights.find((w) => w.groupId === groupId && w.weekStart === weekStart)
    if (row && row.postedAt === null) row.postedAt = at
  }

  // ---- #44 daily reminders ----
  /** feature_track_remind lives on GroupRow; left_at and the daily slot in group_schedules. */
  async listDailyReminderGroups(): Promise<DailyReminderGroup[]> {
    this.fault('listDailyReminderGroups')
    return this.tables.groups
      .filter((g) => g.projectId !== null && g.featureTrackRemind)
      .map((g) => ({ g, s: this.scheduleOf(g.id) }))
      .filter(({ s }) => s.leftAt === null)
      .sort((a, b) => a.g.id.localeCompare(b.g.id))
      .map(({ g, s }) => ({ groupId: g.id, lineGroupId: g.lineGroupId, time: s.dailyReminderTime, lastSentOn: s.dailyReminderLastSentOn }))
  }

  async claimDailyReminder(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }> {
    this.fault('claimDailyReminder')
    if (!this.hasGroup(groupId)) return { claimed: false }
    const s = this.scheduleOf(groupId)
    if (s.dailyReminderLastSentOn !== null && s.dailyReminderLastSentOn >= todayBkk) return { claimed: false }
    const held = s.dailyReminderClaimedAt ?? null
    if (held !== null && held.getTime() >= staleBefore.getTime()) return { claimed: false }
    s.dailyReminderClaimedAt = new Date(at)
    return { claimed: true }
  }

  async finishDailyReminder(groupId: string, todayBkk: string, at: Date): Promise<void> {
    this.fault('finishDailyReminder')
    const s = this.tables.group_schedules.find((row) => row.groupId === groupId)
    if (s && s.dailyReminderClaimedAt?.getTime() === at.getTime()) {
      s.dailyReminderLastSentOn = todayBkk
      s.dailyReminderClaimedAt = null
    }
  }

  async releaseDailyReminder(groupId: string, at: Date): Promise<void> {
    this.fault('releaseDailyReminder')
    const s = this.tables.group_schedules.find((row) => row.groupId === groupId)
    if (s && s.dailyReminderClaimedAt?.getTime() === at.getTime()) s.dailyReminderClaimedAt = null
  }

  // ---- #32 daily member check ----
  async listMemberCheckGroups(): Promise<MemberCheckGroup[]> {
    this.fault('listMemberCheckGroups')
    return this.tables.groups
      .map((g) => ({ g, s: this.scheduleOf(g.id) }))
      .filter(({ s }) => s.leftAt === null)
      .sort((a, b) => a.g.id.localeCompare(b.g.id))
      .map(({ g, s }) => ({ groupId: g.id, lineGroupId: g.lineGroupId, lastCheckedOn: s.memberCheckOn ?? null }))
  }

  async claimMemberCheck(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }> {
    this.fault('claimMemberCheck')
    if (!this.hasGroup(groupId)) return { claimed: false }
    const s = this.scheduleOf(groupId)
    if (s.memberCheckOn != null && s.memberCheckOn >= todayBkk) return { claimed: false }
    const held = s.memberCheckClaimedAt ?? null
    if (held !== null && held.getTime() >= staleBefore.getTime()) return { claimed: false }
    s.memberCheckClaimedAt = new Date(at)
    return { claimed: true }
  }

  async finishMemberCheck(groupId: string, todayBkk: string, at: Date): Promise<void> {
    this.fault('finishMemberCheck')
    const s = this.tables.group_schedules.find((row) => row.groupId === groupId)
    if (s && s.memberCheckClaimedAt?.getTime() === at.getTime()) {
      s.memberCheckOn = todayBkk
      s.memberCheckClaimedAt = null
    }
  }

  async releaseMemberCheck(groupId: string, at: Date): Promise<void> {
    this.fault('releaseMemberCheck')
    const s = this.tables.group_schedules.find((row) => row.groupId === groupId)
    if (s && s.memberCheckClaimedAt?.getTime() === at.getTime()) s.memberCheckClaimedAt = null
  }

  async listMembersToCheck(groupId: string, todayBkk: string): Promise<string[]> {
    this.fault('listMembersToCheck')
    return this.tables.group_members
      .filter((m) => m.groupId === groupId && m.leftAt === null && (m.memberCheckedOn == null || m.memberCheckedOn < todayBkk))
      .map((m) => m.lineUserId)
      .sort()
  }

  async markMemberChecked(groupId: string, lineUserId: string, todayBkk: string): Promise<void> {
    this.fault('markMemberChecked')
    const row = this.tables.group_members.find((m) => m.groupId === groupId && m.lineUserId === lineUserId)
    if (row) row.memberCheckedOn = todayBkk
  }

  /** Oldest first = seed/insert order (the fake keeps no created_at on tasks). */
  async listReminderTasks(groupId: string): Promise<ReminderTask[]> {
    this.fault('listReminderTasks')
    return this.liveTasksOf(groupId)
      .filter((t) => t.status !== 'done')
      .map((t) => ({
        id: t.id, title: t.title, status: t.status, assigneeLineUserId: t.assigneeLineUserId,
        dueAt: t.dueAt, lastActivityAt: t.lastActivityAt, deletedAt: t.deletedAt,
      }))
  }

  // ---- #45 reminder answers ----
  private openLiveTask(taskId: string): TaskRecord | undefined {
    return this.tables.tasks.find((t) => t.id === taskId && t.deletedAt === null && t.status !== 'done')
  }

  async markTaskDone(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('markTaskDone')
    fk(this.hasLineUser(t.by), 'tasks.last_edited_by_line_user_id')
    const row = this.openLiveTask(t.taskId)
    if (!row || row.assigneeLineUserId !== t.by) return { updated: false }
    Object.assign(row, { status: 'done', doneAt: t.at, lastActivityAt: t.at, lastEditedByLineUserId: t.by })
    return { updated: true }
  }

  async postponeTask(t: { taskId: string; dueAt: Date; by: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('postponeTask')
    fk(this.hasLineUser(t.by), 'tasks.last_edited_by_line_user_id')
    const row = this.openLiveTask(t.taskId)
    if (!row || row.assigneeLineUserId !== t.by) return { updated: false }
    Object.assign(row, { dueAt: t.dueAt, lastActivityAt: t.at, lastEditedByLineUserId: t.by })
    return { updated: true }
  }

  async takeTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('takeTask')
    fk(this.hasLineUser(t.by), 'tasks.assignee_line_user_id')
    const row = this.openLiveTask(t.taskId)
    if (!row || row.assigneeLineUserId !== null) return { updated: false }
    Object.assign(row, { assigneeLineUserId: t.by, status: 'in_process', lastActivityAt: t.at, lastEditedByLineUserId: t.by })
    return { updated: true }
  }

  async deleteTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('deleteTask')
    fk(this.hasLineUser(t.by), 'tasks.deleted_by_line_user_id')
    const row = this.openLiveTask(t.taskId)
    if (!row || row.assigneeLineUserId !== null) return { updated: false }
    Object.assign(row, { deletedAt: t.at, deletedByLineUserId: t.by })
    return { updated: true }
  }

  async restoreTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('restoreTask')
    fk(this.hasLineUser(t.by), 'tasks.last_edited_by_line_user_id')
    const row = this.tables.tasks.find((x) => x.id === t.taskId && x.deletedAt !== null && (x.deletedByLineUserId ?? null) !== null)
    if (!row) return { updated: false }
    Object.assign(row, { deletedAt: null, deletedByLineUserId: null, lastActivityAt: t.at, lastEditedByLineUserId: t.by })
    return { updated: true }
  }

  // ---- #52 onboarding ----
  private setupOf(groupId: string): GroupSetupRecord {
    let row = this.tables.group_setups.find((r) => r.groupId === groupId)
    if (!row) {
      fk(this.hasGroup(groupId), 'groups.id')
      row = { groupId, isMain: false, featureSaveFiles: true, ownerNominatedByLineUserId: null, ownerNominatedAt: null }
      this.tables.group_setups.push(row)
    }
    return row
  }

  async setGroupName(groupId: string, name: string): Promise<void> {
    this.fault('setGroupName')
    const g = this.tables.groups.find((row) => row.id === groupId)
    if (g) g.name = name
  }

  async getGroupSetup(groupId: string): Promise<GroupSetup | null> {
    this.fault('getGroupSetup')
    const g = this.tables.groups.find((row) => row.id === groupId)
    if (!g) return null
    const s = this.scheduleOf(groupId)
    const x = this.setupOf(groupId)
    return {
      groupId: g.id, lineGroupId: g.lineGroupId, name: g.name, projectId: g.projectId,
      workDescription: g.workDescription,
      features: {
        summarize: g.featureSummarize, draftTasks: g.featureDraftTasks, saveFiles: x.featureSaveFiles,
        trackRemind: g.featureTrackRemind, weeklySummary: s.featureWeeklySummary,
      },
      dailyReminderTime: s.dailyReminderTime.slice(0, 5),
      weeklySummaryWeekday: s.weeklySummaryWeekday,
      weeklySummaryTime: s.weeklySummaryTime.slice(0, 5),
      nominatedOwnerLineUserId: g.nominatedOwnerLineUserId, ownerConfirmedAt: g.ownerConfirmedAt,
      ownerNominatedAt: x.ownerNominatedAt, ownerLeftAt: g.ownerLeftAt,
    }
  }

  private isLiveMember(groupId: string, lineUserId: string): boolean {
    return this.tables.group_members.some((m) => m.groupId === groupId && m.lineUserId === lineUserId && m.leftAt === null)
  }

  /** Same rules as setup_group, as one step: every check before any write. */
  async saveGroupSetup(w: GroupSetupWrite): Promise<{ outcome: SetupOutcome }> {
    this.fault('saveGroupSetup')
    const g = this.groupOf(w.groupId)
    if (g.ownerConfirmedAt !== null || g.projectId !== null) return { outcome: 'closed' }
    if (!this.isLiveMember(w.groupId, w.ownerLineUserId)) return { outcome: 'owner_not_member' }
    fk(this.hasLineUser(w.byLineUserId), 'groups.owner_nominated_by_line_user_id')
    if (w.workDescription !== null && w.workDescription.length > 2000) throw new Error('check violation: groups.work_description')
    const s = this.scheduleOf(w.groupId)
    const x = this.setupOf(w.groupId)
    Object.assign(g, {
      workDescription: w.workDescription, featureSummarize: w.features.summarize,
      featureDraftTasks: w.features.draftTasks, featureTrackRemind: w.features.trackRemind,
    })
    const newNominee = g.nominatedOwnerLineUserId !== w.ownerLineUserId
    // groups_owner_rules: a new nominee resets the confirmation.
    if (newNominee) g.ownerConfirmedAt = null
    g.nominatedOwnerLineUserId = w.ownerLineUserId
    Object.assign(s, {
      featureWeeklySummary: w.features.weeklySummary, dailyReminderTime: `${w.dailyReminderTime}:00`,
      weeklySummaryWeekday: w.weeklySummaryWeekday, weeklySummaryTime: `${w.weeklySummaryTime}:00`,
    })
    x.featureSaveFiles = w.features.saveFiles
    // Who nominated and when change only with the nominee (the CASEs in setup_group).
    if (newNominee) Object.assign(x, { ownerNominatedByLineUserId: w.byLineUserId, ownerNominatedAt: w.at })
    for (const m of w.members) {
      const row = this.tables.group_members.find((r) => r.groupId === w.groupId && r.lineUserId === m.lineUserId && r.leftAt === null)
      if (row) Object.assign(row, { nicknames: [...m.nicknames], role: m.role })
    }
    if (w.ownerLineUserId === w.byLineUserId) {
      const { outcome } = this.confirmOwner(w.groupId, w.ownerLineUserId, w.at)
      // Cannot happen: the checks above (no confirmed Owner, no Project, the Owner a live
      // Member) are the inner call's, made under the same row lock, and the sender was just
      // named. Should the inner call answer not_nominee, already_confirmed or not_member,
      // setup_group returns that answer and SupabaseStore.saveGroupSetup throws on it (it is
      // not a setup_group outcome); the fake throws here instead, with the same result.
      if (outcome !== 'confirmed') throw new Error(`FakeStore: setup self-confirm ${outcome}`)
      return { outcome: 'confirmed' }
    }
    return { outcome: 'pending' }
  }

  async saveGroupSettings(w: GroupSettingsWrite): Promise<{ saved: boolean }> {
    this.fault('saveGroupSettings')
    const g = this.groupOf(w.groupId)
    if (g.nominatedOwnerLineUserId !== w.ownerLineUserId || g.ownerConfirmedAt === null) return { saved: false }
    if (w.workDescription !== null && w.workDescription.length > 2000) throw new Error('check violation: groups.work_description')
    Object.assign(g, {
      workDescription: w.workDescription, featureSummarize: w.features.summarize,
      featureDraftTasks: w.features.draftTasks, featureTrackRemind: w.features.trackRemind,
    })
    Object.assign(this.scheduleOf(w.groupId), {
      featureWeeklySummary: w.features.weeklySummary, dailyReminderTime: `${w.dailyReminderTime}:00`,
      weeklySummaryWeekday: w.weeklySummaryWeekday, weeklySummaryTime: `${w.weeklySummaryTime}:00`,
    })
    this.setupOf(w.groupId).featureSaveFiles = w.features.saveFiles
    for (const m of w.members) {
      this.settingsMemberWrites++
      const row = this.tables.group_members.find((r) => r.groupId === w.groupId && r.lineUserId === m.lineUserId && r.leftAt === null)
      if (row) Object.assign(row, { nicknames: [...m.nicknames], role: m.role })
    }
    return { saved: true }
  }

  async confirmGroupOwner(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerConfirmOutcome }> {
    this.fault('confirmGroupOwner')
    return this.confirmOwner(groupId, lineUserId, at)
  }

  /** Same rules as confirm_group_owner. */
  private confirmOwner(groupId: string, lineUserId: string, at: Date): { outcome: OwnerConfirmOutcome } {
    const g = this.groupOf(groupId)
    if (g.nominatedOwnerLineUserId !== lineUserId) return { outcome: 'not_nominee' }
    if (g.ownerConfirmedAt !== null) return { outcome: 'already_confirmed' }
    if (g.projectId !== null) return { outcome: 'closed' }
    if (!this.isLiveMember(groupId, lineUserId)) return { outcome: 'not_member' }
    fk(this.hasLineUser(lineUserId), 'projects.owner_line_user_id')
    const project: ProjectRecord = { id: randomUUID(), ownerLineUserId: lineUserId }
    this.tables.projects.push(project)
    g.projectId = project.id
    g.ownerConfirmedAt = at
    g.ownerLeftAt = null // groups_owner_rules: confirming clears owner_left_at
    this.setupOf(groupId).isMain = true
    return { outcome: 'confirmed' }
  }

  // ---- #30 the Owner leaves ----
  /** groups_owner_rules: setting owner_left_at clears owner_confirmed_at. */
  async markOwnerLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('markOwnerLeft')
    const g = this.tables.groups.find((row) => row.id === t.groupId)
    if (!g || g.nominatedOwnerLineUserId !== t.lineUserId || g.ownerConfirmedAt === null) return { updated: false }
    g.ownerLeftAt = new Date(t.at.getTime())
    g.ownerConfirmedAt = null
    return { updated: true }
  }

  /** Same rule as SupabaseStore.listConfirmedOwnersWhoLeft. */
  async listConfirmedOwnersWhoLeft(): Promise<{ groupId: string; lineGroupId: string; lineUserId: string; leftAt: Date }[]> {
    this.fault('listConfirmedOwnersWhoLeft')
    const out: { groupId: string; lineGroupId: string; lineUserId: string; leftAt: Date }[] = []
    for (const g of [...this.tables.groups].sort((a, b) => a.id.localeCompare(b.id))) {
      if (g.ownerConfirmedAt === null || g.nominatedOwnerLineUserId === null || this.isLeft(g.id)) continue
      const m = this.tables.group_members.find((x) => x.groupId === g.id && x.lineUserId === g.nominatedOwnerLineUserId)
      if (m?.leftAt && m.leftAt >= g.ownerConfirmedAt) out.push({ groupId: g.id, lineGroupId: g.lineGroupId, lineUserId: m.lineUserId, leftAt: new Date(m.leftAt.getTime()) })
    }
    return out
  }

  /** The unique index task_prompts_one_open_owner_needed: one open card per group. */
  async openOwnerNeededPrompt(p: { groupId: string; subjectLineUserId: string | null; askedAt: Date }): Promise<{ promptId: string | null }> {
    this.fault('openOwnerNeededPrompt')
    fk(this.hasGroup(p.groupId), 'task_prompts.group_id')
    fk(p.subjectLineUserId === null || this.hasLineUser(p.subjectLineUserId), 'task_prompts.subject_line_user_id')
    if (this.tables.owner_prompts.some((r) => r.groupId === p.groupId && r.answer === null)) return { promptId: null }
    const row: OwnerPromptRecord = {
      id: randomUUID(), groupId: p.groupId, subjectLineUserId: p.subjectLineUserId, askedAt: new Date(p.askedAt.getTime()),
      answer: null, answeredByLineUserId: null, answeredAt: null,
    }
    this.tables.owner_prompts.push(row)
    return { promptId: row.id }
  }

  /** Same rules as SupabaseStore.claimOwnerChange. */
  async claimOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerClaimOutcome }> {
    this.fault('claimOwnerChange')
    const g = this.tables.groups.find((row) => row.id === groupId)
    if (!g || g.ownerLeftAt === null || g.ownerConfirmedAt !== null || this.isLeft(groupId)) {
      return { outcome: 'not_pending' }
    }
    if (g.projectId !== null && !this.isMainGroup(groupId)) return { outcome: 'not_main_group' }
    const nominee = g.nominatedOwnerLineUserId
    if (nominee === lineUserId) return { outcome: 'already_claimed' }
    if (nominee !== null && this.isLiveMember(groupId, nominee)) return { outcome: 'taken' }
    fk(this.hasLineUser(lineUserId), 'groups.nominated_owner_line_user_id')
    g.nominatedOwnerLineUserId = lineUserId
    Object.assign(this.setupOf(groupId), { ownerNominatedByLineUserId: lineUserId, ownerNominatedAt: new Date(at.getTime()) })
    return { outcome: 'claimed' }
  }

  /** Same rules and writes as complete_owner_change, change_project_owner included. The
   *  database stamps owner_confirmed_at and status_changed_at with now(): the fake clock. */
  async completeOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: CompleteOwnerChangeOutcome }> {
    this.fault('completeOwnerChange')
    const g = this.groupOf(groupId)
    if (g.ownerConfirmedAt !== null && g.nominatedOwnerLineUserId === lineUserId) return { outcome: 'already_owner' }
    if (g.projectId === null || !this.isMainGroup(groupId) || g.ownerLeftAt === null || g.ownerConfirmedAt !== null ||
      this.isLeft(groupId)) return { outcome: 'not_pending' }
    if (g.nominatedOwnerLineUserId !== lineUserId) return { outcome: 'not_nominee' }
    if (!this.isLiveMember(groupId, lineUserId)) return { outcome: 'not_member' }
    if (this.latestGoogleAccount(lineUserId)?.tokenStatus !== 'valid') return { outcome: 'needs_drive' }
    this.changeProjectOwnerRows(g.projectId, g, lineUserId)
    for (const r of this.tables.owner_prompts.filter((p) => p.groupId === groupId && p.answer === null)) {
      Object.assign(r, { answer: 'owner_confirmed', answeredByLineUserId: lineUserId, answeredAt: new Date(at.getTime()) })
    }
    return { outcome: 'changed' }
  }

  async answerOwnerNeededPrompt(groupId: string, byLineUserId: string, at: Date): Promise<void> {
    this.fault('answerOwnerNeededPrompt')
    for (const r of this.tables.owner_prompts.filter((p) => p.groupId === groupId && p.answer === null)) {
      Object.assign(r, { answer: 'owner_confirmed', answeredByLineUserId: byLineUserId, answeredAt: new Date(at.getTime()) })
    }
  }

  async listPendingOwnerChanges(lineUserId: string): Promise<string[]> {
    this.fault('listPendingOwnerChanges')
    return this.tables.groups
      .filter((g) => g.nominatedOwnerLineUserId === lineUserId && (this.isMainGroup(g.id) || g.projectId === null) && g.ownerLeftAt !== null &&
        g.ownerConfirmedAt === null && !this.isLeft(g.id))
      .map((g) => g.id)
      .sort()
  }

  async markMemberLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }> {
    this.fault('markMemberLeft')
    const row = this.tables.group_members.find((m) => m.groupId === t.groupId && m.lineUserId === t.lineUserId)
    if (!row) {
      // Same as SupabaseStore: no row yet -> a left row, so a late message cannot add them back.
      fk(this.hasGroup(t.groupId), 'group_members.group_id')
      fk(this.hasLineUser(t.lineUserId), 'group_members.line_user_id')
      this.tables.group_members.push({
        groupId: t.groupId, lineUserId: t.lineUserId, nicknames: [], role: null, source: 'message', leftAt: t.at, membershipEventAt: t.at,
      })
      return { updated: true }
    }
    if (!membershipOlderThan(row, t.at)) return { updated: false }
    row.leftAt = t.at
    row.membershipEventAt = t.at
    return { updated: true }
  }

  async markMemberJoined(t: { groupId: string; lineUserId: string; at: Date }): Promise<void> {
    this.fault('markMemberJoined')
    const row = this.tables.group_members.find((m) => m.groupId === t.groupId && m.lineUserId === t.lineUserId)
    if (!row) {
      fk(this.hasGroup(t.groupId), 'group_members.group_id')
      fk(this.hasLineUser(t.lineUserId), 'group_members.line_user_id')
      this.tables.group_members.push({
        groupId: t.groupId, lineUserId: t.lineUserId, nicknames: [], role: null, source: 'member_join', leftAt: null, membershipEventAt: t.at,
      })
      return
    }
    if (!membershipOlderThan(row, t.at)) return
    row.leftAt = null
    row.membershipEventAt = t.at
  }

  async setMemberProfile(t: { groupId: string; lineUserId: string; nicknames: string[]; role: string | null }): Promise<{ updated: boolean }> {
    this.fault('setMemberProfile')
    const row = this.tables.group_members.find((m) => m.groupId === t.groupId && m.lineUserId === t.lineUserId && m.leftAt === null)
    if (!row) return { updated: false }
    row.nicknames = [...t.nicknames]
    row.role = t.role
    return { updated: true }
  }

  async releaseTasksIfLeft(t: { groupId: string; lineUserId: string }): Promise<TaskRow[]> {
    this.fault('releaseTasksIfLeft')
    // Same as release_tasks_if_left: a live Member keeps their Tasks.
    const member = this.tables.group_members.find((m) => m.groupId === t.groupId && m.lineUserId === t.lineUserId)
    if (member && member.leftAt === null) return []
    const rows = this.tables.tasks.filter((x) =>
      x.groupId === t.groupId && x.assigneeLineUserId === t.lineUserId && x.deletedAt === null && x.status !== 'done')
    for (const x of rows) Object.assign(x, { assigneeLineUserId: null, status: 'not_assigned' })
    return rows.map((x) => this.toTaskRow(x))
  }

  // ---- #31 Project Owner change ----
  /** Same steps as change_project_owner, as one step: every check before any write. The
   *  database's now() is this.clock(). */
  async changeProjectOwner(projectId: string, newOwnerLineUserId: string): Promise<{ outcome: OwnerChangeOutcome }> {
    this.fault('changeProjectOwner')
    const main = this.tables.groups.find((g) =>
      g.projectId === projectId && this.isMainGroup(g.id) && g.nominatedOwnerLineUserId === newOwnerLineUserId)
    if (!main) return { outcome: 'not_nominee' }
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (!project) throw new Error('FakeStore: main group without its Project')
    fk(this.hasLineUser(newOwnerLineUserId), 'projects.owner_line_user_id')
    this.changeProjectOwnerRows(projectId, main, newOwnerLineUserId)
    return { outcome: 'changed' }
  }

  /** change_project_owner's writes (20261116010000), shared by changeProjectOwner and
   *  completeOwnerChange, then the same-Owner rule check_same_owner runs at COMMIT. D1: a
   *  Sub group is asked (again) only while it waits, or when it does not run on the new
   *  Owner yet; one already confirmed on them keeps running, folder included. An asked Sub
   *  group's folder ID is cleared (it points into the old Owner's Drive). */
  private changeProjectOwnerRows(projectId: string, main: GroupRow, newOwner: string): void {
    const now = this.clock()
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (project) Object.assign(project, { ownerLineUserId: newOwner, driveProjectFolderId: null })
    main.ownerConfirmedAt = now
    main.ownerLeftAt = null // groups_owner_rules: confirming clears owner_left_at
    this.setupOf(main.id).driveFolderId = null
    for (const sub of this.tables.groups.filter((r) => r.projectId === projectId && !this.isMainGroup(r.id))) {
      const runsOnNewOwner = sub.nominatedOwnerLineUserId === newOwner && sub.ownerConfirmedAt !== null
      if (this.takeoverAskedAt(sub.id) === null && runsOnNewOwner) continue
      sub.ownerConfirmedAt = null
      Object.assign(this.setupOf(sub.id), { takeoverAskedAt: now, driveFolderId: null })
    }
    for (const c of this.tables.drive_connections.filter((r) => r.projectId === projectId && r.status === 'active')) {
      c.status = 'replaced'
      c.statusChangedAt = now
    }
    this.checkSameOwner(projectId)
  }

  /** check_same_owner (initial schema): every group attached to a Project names its owner,
   *  except an unconfirmed main group nominee and a Sub group waiting on the question. */
  private checkSameOwner(projectId: string): void {
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (!project) return
    for (const g of this.tables.groups.filter((r) => r.projectId === projectId)) {
      if (g.nominatedOwnerLineUserId === project.ownerLineUserId) continue
      if (this.isMainGroup(g.id) && g.ownerConfirmedAt === null) continue
      if (this.takeoverAskedAt(g.id) !== null) continue
      throw new Error(`FakeStore check violation: group Owner must be the Project owner (${g.id})`)
    }
  }

  private takeoverAskedAt(groupId: string): Date | null {
    return this.tables.group_setups.find((r) => r.groupId === groupId)?.takeoverAskedAt ?? null
  }

  async getOwnerChange(projectId: string): Promise<OwnerChangeState | null> {
    this.fault('getOwnerChange')
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (!project) return null
    const groups = this.tables.groups.filter((g) => g.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id))
    const main = groups.find((g) => this.isMainGroup(g.id))
    return {
      projectId, ownerLineUserId: project.ownerLineUserId,
      mainGroup: main
        ? {
            groupId: main.id, lineGroupId: main.lineGroupId, name: main.name,
            nominatedOwnerLineUserId: main.nominatedOwnerLineUserId, ownerConfirmedAt: main.ownerConfirmedAt,
          }
        : null,
      waiting: groups
        .filter((g) => !this.isMainGroup(g.id) && this.takeoverAskedAt(g.id) !== null)
        .map((g) => ({ groupId: g.id, lineGroupId: g.lineGroupId, name: g.name, askedAt: this.takeoverAskedAt(g.id) as Date })),
    }
  }

  /** Same rules as answer_subgroup_takeover (20261112143751). A chosen group that is not a
   *  waiting Sub group of the Project raises check_violation there: 'changed' here, as
   *  SupabaseStore maps it, with nothing written. */
  async answerSubgroupTakeover(projectId: string, takeoverGroupIds: string[]): Promise<{ outcome: TakeoverAnswerOutcome }> {
    this.fault('answerSubgroupTakeover')
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (!project) throw new Error(`check violation: unknown Project ${projectId}`)
    const takeover = [...new Set(takeoverGroupIds)]
    const waitingHere = (g: GroupRow) => g.projectId === projectId && this.takeoverAskedAt(g.id) !== null
    // 20261116010000: a question older than 7 days raises NJ409, nothing written.
    const cutoff = this.clock().getTime() - 7 * 86_400_000
    if (this.tables.groups.some((g) => waitingHere(g) && (this.takeoverAskedAt(g.id) as Date).getTime() < cutoff)) {
      return { outcome: 'expired' }
    }
    if (takeover.some((id) => { const g = this.tables.groups.find((x) => x.id === id); return !g || !waitingHere(g) })) {
      return { outcome: 'changed' }
    }
    const now = this.clock()
    const owner = project.ownerLineUserId
    for (const g of this.tables.groups) {
      if (!waitingHere(g)) continue
      const x = this.setupOf(g.id)
      x.takeoverAskedAt = null
      if (!takeover.includes(g.id)) {
        // Detach (review-followups migration): the old Owner's folder ID and nominee go, and
        // the Owner count starts (owner_left_at never moves back).
        g.projectId = null
        g.nominatedOwnerLineUserId = null
        Object.assign(x, { driveFolderId: null, ownerNominatedByLineUserId: null, ownerNominatedAt: null })
        g.ownerLeftAt = g.ownerLeftAt && g.ownerLeftAt > now ? g.ownerLeftAt : now
        continue
      }
      g.nominatedOwnerLineUserId = owner
      Object.assign(x, { ownerNominatedByLineUserId: owner, ownerNominatedAt: now, driveFolderId: null })
      g.ownerConfirmedAt = now
    }
    return { outcome: 'saved' }
  }

  async detachExpiredTakeovers(askedBefore: Date, at?: Date): Promise<DetachedSubGroup[]> {
    this.fault('detachExpiredTakeovers')
    const out: DetachedSubGroup[] = []
    for (const g of this.tables.groups) {
      const asked = this.takeoverAskedAt(g.id)
      if (asked === null || asked >= askedBefore) continue
      Object.assign(this.setupOf(g.id), { takeoverAskedAt: null, driveFolderId: null })
      g.projectId = null
      if (at) g.ownerLeftAt = new Date(at.getTime())
      out.push({ groupId: g.id, lineGroupId: g.lineGroupId, name: g.name, nominatedOwnerLineUserId: g.nominatedOwnerLineUserId })
    }
    return out.sort((a, b) => a.groupId.localeCompare(b.groupId))
  }

  async startDetachedOwnerCount(groupIds: string[], at: Date): Promise<DetachedSubGroup[]> {
    this.fault('startDetachedOwnerCount')
    const out: DetachedSubGroup[] = []
    for (const g of this.tables.groups) {
      if (!groupIds.includes(g.id) || g.projectId !== null || g.ownerConfirmedAt !== null) continue
      if (g.ownerLeftAt !== null && g.ownerLeftAt >= at) continue
      g.ownerLeftAt = new Date(at.getTime())
      out.push({ groupId: g.id, lineGroupId: g.lineGroupId, name: g.name, nominatedOwnerLineUserId: g.nominatedOwnerLineUserId })
    }
    return out.sort((a, b) => a.groupId.localeCompare(b.groupId))
  }

  /** Same rule as SupabaseStore.listUnsentTakeoverCards. */
  async listUnsentTakeoverCards(askedAfter: Date): Promise<{ projectId: string; askedAt: Date }[]> {
    this.fault('listUnsentTakeoverCards')
    const askedAt = new Map<string, number>()
    for (const g of this.tables.groups) {
      const asked = this.takeoverAskedAt(g.id)
      if (asked === null || asked < askedAfter || g.projectId === null) continue
      askedAt.set(g.projectId, Math.min(askedAt.get(g.projectId) ?? asked.getTime(), asked.getTime()))
    }
    return [...askedAt.keys()].sort().filter((projectId) => {
      const main = this.tables.groups.find((g) => g.projectId === projectId && this.isMainGroup(g.id))
      if (!main) return false
      return !this.tables.push_log.some((p) =>
        p.purpose === 'owner_takeover' && p.lineTargetId === main.lineGroupId && p.sentAt.getTime() >= (askedAt.get(projectId) as number))
    }).map((projectId) => ({ projectId, askedAt: new Date(askedAt.get(projectId) as number) }))
  }

  /** Same rule as SupabaseStore.listPausedOwnerCards. */
  async listPausedOwnerCards(): Promise<PausedOwnerCard[]> {
    this.fault('listPausedOwnerCards')
    return [...this.tables.groups]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((g) => g.ownerLeftAt != null && g.ownerConfirmedAt === null && !this.isLeft(g.id))
      .map((g) => {
        const p = this.tables.owner_prompts.find((x) => x.groupId === g.id && x.answer === null)
        return {
          groupId: g.id, lineGroupId: g.lineGroupId, ownerLineUserId: g.nominatedOwnerLineUserId,
          card: p
            ? {
                promptId: p.id, askedAt: new Date(p.askedAt.getTime()),
                pushed: this.tables.push_log.some((x) =>
                  x.purpose === 'owner_needed' && x.lineTargetId === g.lineGroupId && x.sentAt >= p.askedAt),
              }
            : null,
        }
      })
  }

  // ---- #11 removal and recovery ----
  async markBotLeft(m: { lineGroupId: string; at: Date }): Promise<{ deleteAfter: Date | null }> {
    this.fault('markBotLeft')
    const g = this.tables.groups.find((row) => row.lineGroupId === m.lineGroupId)
    if (!g) return { deleteAfter: null }
    const s = this.scheduleOf(g.id)
    const joinedAt = s.joinedAt ?? null
    if (s.leftAt === null && (joinedAt === null || joinedAt <= m.at)) {
      s.leftAt = new Date(m.at.getTime())
      s.deleteAfter = new Date(m.at.getTime() + 7 * 86_400_000)
    }
    return { deleteAfter: s.deleteAfter ? new Date(s.deleteAfter.getTime()) : null }
  }

  async getGroupDeleteAfter(groupId: string): Promise<Date | null> {
    this.fault('getGroupDeleteAfter')
    const d = this.tables.group_schedules.find((r) => r.groupId === groupId)?.deleteAfter ?? null
    return d ? new Date(d.getTime()) : null
  }

  async markBotJoined(j: { groupId: string; at: Date }): Promise<void> {
    this.fault('markBotJoined')
    const g = this.tables.groups.find((row) => row.id === j.groupId)
    if (!g) return
    const s = this.scheduleOf(g.id)
    if (g.ownerConfirmedAt === null && g.ownerLeftAt !== null && g.ownerLeftAt < j.at) g.ownerLeftAt = new Date(j.at.getTime())
    if (s.joinedAt == null || s.joinedAt < j.at) s.joinedAt = new Date(j.at.getTime())
    if (s.leftAt !== null && s.leftAt <= j.at) {
      s.leftAt = null
      s.deleteAfter = null
    }
  }

  /** Same rule as SupabaseStore: no confirmed Owner, owner_left_at <= leftBefore, bot in. */
  async listOwnerlessGroups(leftBefore: Date, limit: number): Promise<OwnerlessGroup[]> {
    this.fault('listOwnerlessGroups')
    return this.tables.groups
      .filter((g) => g.ownerConfirmedAt === null && g.ownerLeftAt !== null && g.ownerLeftAt <= leftBefore && !this.isLeft(g.id))
      .sort((a, b) => (a.ownerLeftAt as Date).getTime() - (b.ownerLeftAt as Date).getTime() || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((g) => ({
        groupId: g.id, lineGroupId: g.lineGroupId, subGroup: g.projectId !== null && !this.isMainGroup(g.id),
        nominatedOwnerLineUserId: g.nominatedOwnerLineUserId,
        ownerLeftAt: new Date((g.ownerLeftAt as Date).getTime()), joinedAt: this.joinedAtOf(g.id),
      }))
  }

  private joinedAtOf(groupId: string): Date | null {
    const j = this.tables.group_schedules.find((r) => r.groupId === groupId)?.joinedAt ?? null
    return j ? new Date(j.getTime()) : null
  }

  async getOwnerExitState(groupId: string): Promise<OwnerExitState | null> {
    this.fault('getOwnerExitState')
    const g = this.tables.groups.find((r) => r.id === groupId)
    if (!g) return null
    const s = this.tables.group_schedules.find((r) => r.groupId === groupId)
    const copy = (d: Date | null | undefined) => (d ? new Date(d.getTime()) : null)
    return {
      ownerConfirmedAt: copy(g.ownerConfirmedAt), ownerLeftAt: copy(g.ownerLeftAt), leftAt: copy(s?.leftAt),
      joinedAt: copy(s?.joinedAt), subGroup: g.projectId !== null && !this.isMainGroup(g.id),
      ownerNominatedAt: copy(this.tables.group_setups.find((r) => r.groupId === groupId)?.ownerNominatedAt),
    }
  }

  /** The one conditional UPDATE of SupabaseStore. */
  async detachOwnerlessSubGroup(groupId: string, leftBefore: Date, at: Date): Promise<{ detached: boolean }> {
    this.fault('detachOwnerlessSubGroup')
    const g = this.tables.groups.find((r) => r.id === groupId)
    if (!g || g.projectId === null || this.isMainGroup(groupId) || g.ownerConfirmedAt !== null ||
      g.ownerLeftAt === null || g.ownerLeftAt > leftBefore || this.isLeft(groupId)) return { detached: false }
    g.projectId = null
    g.ownerLeftAt = new Date(at.getTime())
    Object.assign(this.setupOf(groupId), { takeoverAskedAt: null, driveFolderId: null })
    return { detached: true }
  }

  async listPurgeDueGroups(now: Date, limit: number): Promise<string[]> {
    this.fault('listPurgeDueGroups')
    return this.tables.group_schedules
      .filter((s) => s.deleteAfter != null && s.deleteAfter <= now)
      .sort((a, b) => (a.deleteAfter as Date).getTime() - (b.deleteAfter as Date).getTime())
      .slice(0, limit)
      .map((s) => s.groupId)
  }

  /** Mirrors the schema's cascade: group-keyed rows go, ai_usage keeps its rows with
   *  groupId null, push_log and webhook_events have no group link and stay. */
  async purgeGroup(groupId: string, now: Date): Promise<{ purged: boolean }> {
    this.fault('purgeGroup')
    const s = this.tables.group_schedules.find((r) => r.groupId === groupId)
    if (!s || s.deleteAfter == null || s.deleteAfter > now) return { purged: false }
    const t = this.tables
    const summaryIds = new Set(t.summaries.filter((x) => x.groupId === groupId).map((x) => x.id))
    t.groups = t.groups.filter((g) => g.id !== groupId)
    t.group_members = t.group_members.filter((x) => x.groupId !== groupId)
    t.messages = t.messages.filter((x) => x.groupId !== groupId)
    t.summaries = t.summaries.filter((x) => x.groupId !== groupId)
    t.task_candidates = t.task_candidates.filter((x) => !summaryIds.has(x.summaryId))
    t.tasks = t.tasks.filter((x) => x.groupId !== groupId)
    t.task_prompts = t.task_prompts.filter((x) => x.groupId !== groupId)
    t.fair_use_notices = t.fair_use_notices.filter((x) => x.groupId !== groupId)
    t.group_schedules = t.group_schedules.filter((x) => x.groupId !== groupId)
    t.weekly_insights = t.weekly_insights.filter((x) => x.groupId !== groupId)
    t.group_setups = t.group_setups.filter((x) => x.groupId !== groupId)
    for (const u of t.ai_usage) if (u.groupId === groupId) u.groupId = null
    return { purged: true }
  }

  // ---- Seed helpers (not on the port). They create the line_users rows they reference. ----
  /** Sets a group's weekly slot, feature toggle or left_at (the rest keep the defaults). */
  /** `ownerLeftAt` is written to the group row (GroupRow.ownerLeftAt), its one home. */
  seedSchedule(groupId: string, partial: Partial<Omit<GroupScheduleRecord, 'groupId'>> & { ownerLeftAt?: Date | null }): void {
    const { ownerLeftAt, ...rest } = partial
    if (ownerLeftAt !== undefined) this.groupOf(groupId).ownerLeftAt = ownerLeftAt
    Object.assign(this.scheduleOf(groupId), rest)
  }

  seedGroup(partial: Partial<GroupRow> = {}): GroupRow {
    const row: GroupRow = {
      id: randomUUID(), lineGroupId: 'Cgroup1', projectId: null, name: null,
      nominatedOwnerLineUserId: null, ownerConfirmedAt: null,
      featureSummarize: true, featureDraftTasks: true, workDescription: null, featureTrackRemind: true,
      ownerLeftAt: null,
      ...partial,
    }
    unique(this.tables.groups.some((g) => g.id === row.id), 'groups.id')
    unique(this.tables.groups.some((g) => g.lineGroupId === row.lineGroupId), 'groups.line_group_id')
    this.ensureLineUserRow(row.nominatedOwnerLineUserId)
    this.tables.groups.push(row)
    return { ...row }
  }

  seedMember(p: {
    groupId: string; lineUserId: string; displayName: string
    nicknames?: string[]; role?: string; leftAt?: Date; isPm?: boolean
  }): void {
    fk(this.hasGroup(p.groupId), 'group_members.group_id')
    const user = this.tables.line_users.find((u) => u.lineUserId === p.lineUserId)
    if (user) user.displayName = p.displayName
    else this.tables.line_users.push({ lineUserId: p.lineUserId, displayName: p.displayName })
    const record: GroupMemberRecord = {
      groupId: p.groupId, lineUserId: p.lineUserId, nicknames: [...(p.nicknames ?? [])],
      role: p.role ?? null, source: 'setup_form', leftAt: p.leftAt ?? null, isPm: p.isPm === true,
    }
    const i = this.tables.group_members.findIndex((m) => m.groupId === p.groupId && m.lineUserId === p.lineUserId)
    if (i === -1) this.tables.group_members.push(record)
    else this.tables.group_members[i] = record
  }

  /** A files row as #4 will write it (#33 reads it). messageId is messages.id or null. */
  seedFile(p: { groupId: string; messageId: string | null; fileName: string; driveLink: string; savedAt?: Date }): FileRecord {
    fk(this.hasGroup(p.groupId), 'files.group_id')
    fk(p.messageId === null || this.tables.messages.some((m) => m.id === p.messageId), 'files.message_id')
    const row: FileRecord = {
      id: randomUUID(), groupId: p.groupId, messageId: p.messageId, fileName: p.fileName, driveLink: p.driveLink,
      savedAt: p.savedAt ?? SEED_NOW, senderLineUserId: null, driveConnectionId: 'seeded-connection',
      contentSha256: randomUUID(), driveFileId: 'seeded-file', sentAt: p.savedAt ?? SEED_NOW, sizeBytes: null,
    }
    this.tables.files.push(row)
    return { ...row }
  }

  /** A Project row owned by `ownerLineUserId` (creates the line_users row); attach groups with seedGroup({ projectId }). */
  seedProject(ownerLineUserId: string): ProjectRecord {
    this.ensureLineUserRow(ownerLineUserId)
    const project: ProjectRecord = { id: randomUUID(), ownerLineUserId }
    this.tables.projects.push(project)
    return { ...project }
  }

  seedAiUsage(partial: Partial<NewAiUsage> = {}): void {
    const row: AiUsageRecord = {
      ownerLineUserId: 'Uowner1', projectId: null, groupId: null, purpose: 'summary',
      model: 'openai/gpt-oss-20b', inputTokens: 0, outputTokens: 0, costUsd: 0, createdAt: SEED_NOW,
      ...partial, id: randomUUID(), settledAt: partial.createdAt ?? SEED_NOW,
    }
    fk(this.hasGroup(row.groupId), 'ai_usage.group_id')
    this.ensureLineUserRow(row.ownerLineUserId)
    this.tables.ai_usage.push(row)
  }

  seedTask(partial: Partial<TaskRow> & { groupId: string; title: string; createdByLineUserId: string }): TaskRow {
    const rest: Partial<TaskRow> = { ...partial }
    delete rest.lineGroupId // derived from the group, not stored on tasks
    fk(this.hasGroup(partial.groupId), 'tasks.group_id')
    const row: TaskRecord = {
      id: randomUUID(), candidateId: null, details: null, status: 'not_assigned',
      assigneeLineUserId: null, dueAt: null, deletedAt: null, announcedAt: null,
      lastEditedByLineUserId: null, lastActivityAt: null, doneAt: null,
      announcePendingToken: null, announcePendingAt: null,
      ...rest, groupId: partial.groupId, title: partial.title, createdByLineUserId: partial.createdByLineUserId,
    }
    unique(row.candidateId !== null && this.tables.tasks.some((t) => t.candidateId === row.candidateId), 'tasks.candidate_id')
    this.ensureLineUserRow(row.createdByLineUserId)
    this.ensureLineUserRow(row.assigneeLineUserId)
    this.checkTaskFks(row)
    this.tables.tasks.push(row)
    return this.toTaskRow(row)
  }
}
