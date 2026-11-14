import { randomUUID } from 'node:crypto'
import type {
  AiUsageActual,
  AiUsageCap,
  AnnounceClaim,
  CandidateRow,
  CandidateState,
  GroupRow,
  GroupSetup,
  GroupSetupWrite,
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
  OwnerConfirmOutcome,
  PushBudgetClaim,
  NewWeeklyInsight,
  DailyReminderGroup,
  DriveContext,
  DriveGroup,
  ReminderTask,
  MessageRef,
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
}
export type MessageRecord = NewMessage & { id: string }
export type SummaryRecord = NewSummary & { id: string }
export type CandidateRecord = CandidateRow & {
  decidedByLineUserId: string | null; decidedAt: Date | null; createdAt: Date
}
export type TaskRecord = Omit<TaskRow, 'lineGroupId'> & {
  lastEditedByLineUserId: string | null; lastActivityAt: Date | null; doneAt: Date | null
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
}
export type WeeklyInsightRecord = NewWeeklyInsight & { id: string; postedAt: Date | null }
/** The other groups columns setup writes (#52). No row = schema defaults. */
export type GroupSetupRecord = {
  groupId: string; isMain: boolean; featureSaveFiles: boolean
  ownerNominatedByLineUserId: string | null; ownerNominatedAt: Date | null
  driveFolderId?: string | null   // groups.drive_folder_id; absent = null (#13)
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
  async deleteMessageByLineId(lineMessageId: string): Promise<{ deleted: boolean }> {
    this.fault('deleteMessageByLineId')
    const i = this.tables.messages.findIndex((row) => row.lineMessageId === lineMessageId)
    if (i === -1) return { deleted: false }
    const [gone] = this.tables.messages.splice(i, 1)
    // task_prompts.trigger_message_id is ON DELETE SET NULL.
    for (const p of this.tables.task_prompts) if (p.triggerMessageId === gone.id) p.triggerMessageId = null
    return { deleted: true }
  }

  async getMessageRef(messageId: string): Promise<MessageRef | null> {
    this.fault('getMessageRef')
    const m = this.tables.messages.find((row) => row.id === messageId)
    return m ? { id: m.id, groupId: m.groupId, senderLineUserId: m.senderLineUserId, sentAt: m.sentAt } : null
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

  // ---- #12 Google ----
  async upsertGoogleAccount(a: NewGoogleAccount): Promise<{ id: string }> {
    this.fault('upsertGoogleAccount')
    fk(this.hasLineUser(a.lineUserId), 'google_accounts.line_user_id')
    let row = this.tables.google_accounts.find((g) => g.googleSubject === a.googleSubject)
    if (row) {
      Object.assign(row, { ...a, grantedScopes: [...a.grantedScopes], tokenStatus: 'valid' })
    } else {
      row = { ...a, grantedScopes: [...a.grantedScopes], id: randomUUID(), tokenStatus: 'valid', updatedAt: this.clock() }
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
  async findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired' } | null> {
    this.fault('findGoogleAccountByLineUser')
    const row = this.latestGoogleAccount(lineUserId)
    return row ? { id: row.id, tokenStatus: row.tokenStatus } : null
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

  /** As SupabaseStore: nothing unless another account holds the active row; then the folder
   *  IDs of the Project and of every one of its groups are cleared and the row is retired. */
  async retireDriveConnection(projectId: string, keepGoogleAccountId: string, at: Date): Promise<{ retired: boolean }> {
    this.fault('retireDriveConnection')
    const active = this.tables.drive_connections.find((c) => c.projectId === projectId && c.status === 'active')
    if (!active || active.googleAccountId === keepGoogleAccountId) return { retired: false }
    const project = this.tables.projects.find((p) => p.id === projectId)
    if (project) project.driveProjectFolderId = null
    for (const g of this.tables.groups.filter((row) => row.projectId === projectId)) {
      const setup = this.tables.group_setups.find((r) => r.groupId === g.id)
      if (setup) setup.driveFolderId = null
    }
    active.status = 'replaced'
    active.statusChangedAt = new Date(at.getTime())
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
      .filter((g) => g.projectId !== null)
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
      ownerNominatedAt: x.ownerNominatedAt,
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
    this.setupOf(groupId).isMain = true
    return { outcome: 'confirmed' }
  }

  // ---- Seed helpers (not on the port). They create the line_users rows they reference. ----
  /** Sets a group's weekly slot, feature toggle or left_at (the rest keep the defaults). */
  seedSchedule(groupId: string, partial: Partial<Omit<GroupScheduleRecord, 'groupId'>>): void {
    Object.assign(this.scheduleOf(groupId), partial)
  }

  seedGroup(partial: Partial<GroupRow> = {}): GroupRow {
    const row: GroupRow = {
      id: randomUUID(), lineGroupId: 'Cgroup1', projectId: null, name: null,
      nominatedOwnerLineUserId: null, ownerConfirmedAt: null,
      featureSummarize: true, featureDraftTasks: true, workDescription: null, featureTrackRemind: true,
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
    nicknames?: string[]; role?: string; leftAt?: Date
  }): void {
    fk(this.hasGroup(p.groupId), 'group_members.group_id')
    const user = this.tables.line_users.find((u) => u.lineUserId === p.lineUserId)
    if (user) user.displayName = p.displayName
    else this.tables.line_users.push({ lineUserId: p.lineUserId, displayName: p.displayName })
    const record: GroupMemberRecord = {
      groupId: p.groupId, lineUserId: p.lineUserId, nicknames: [...(p.nicknames ?? [])],
      role: p.role ?? null, source: 'setup_form', leftAt: p.leftAt ?? null,
    }
    const i = this.tables.group_members.findIndex((m) => m.groupId === p.groupId && m.lineUserId === p.lineUserId)
    if (i === -1) this.tables.group_members.push(record)
    else this.tables.group_members[i] = record
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
