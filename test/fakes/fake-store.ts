import { randomUUID } from 'node:crypto'
import type {
  AiUsageActual,
  AiUsageCap,
  CandidateRow,
  CandidateState,
  GroupRow,
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
  PushBudgetClaim,
  MessageRef,
  ProgressPromptRow,
  StorePort,
  StoredMessage,
  SummaryRow,
  TaskPatch,
  TaskRow,
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
  announcePendingToken?: string | null
  lastEditedByLineUserId: string | null; lastActivityAt: Date | null; doneAt: Date | null
}
export type PushLogRecord = { id: string; purpose: string; lineTargetId: string; messageCount: number; sentAt: Date }
/** task_prompts, kind mark_done only (the kind #7 writes). */
export type ProgressPromptRecord = ProgressPromptRow
export type AiUsageRecord = NewAiUsage & { id: string; settledAt: Date | null } // settledAt null = open claim
export type FairUseNoticeRecord = { ownerLineUserId: string; groupId: string; monthStartBkk: string; kind: 'warn_80' }
export type GoogleAccountRecord = {
  id: string; lineUserId: string; googleSubject: string; email: string | null; grantedScopes: string[]
  refreshTokenCiphertext: string | null; tokenStatus: 'valid' | 'revoked' | 'expired'
}

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
  }

  private faults: { method: keyof StorePort; err: Error; skip: number }[] = []
  // Write order of google_accounts rows, so the newest connection wins on lookup.
  private googleWrites = new Map<string, number>()
  private googleWriteSeq = 0

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
        ...t, id: taskId, deletedAt: null, announcedAt: null, announcePendingAt: null, lastEditedByLineUserId: null, lastActivityAt: null, doneAt: null,
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
      announcePendingAt: t.announcePendingAt,
    }
  }

  async getTask(taskId: string): Promise<TaskRow | null> {
    this.fault('getTask')
    const t = this.tables.tasks.find((row) => row.id === taskId)
    return t ? this.toTaskRow(t) : null
  }

  async claimTaskAnnouncements(
    taskIds: string[], at: Date, opts: { staleBefore: Date; takeOverToken: string | null },
  ): Promise<string[]> {
    this.fault('claimTaskAnnouncements')
    const rows = this.tables.tasks.filter((t) =>
      taskIds.includes(t.id) && !t.announcedAt && t.deletedAt === null &&
      (!t.announcePendingToken || (t.announcePendingAt !== null && t.announcePendingAt < opts.staleBefore) ||
        (opts.takeOverToken !== null && t.announcePendingToken === opts.takeOverToken)))
    for (const t of rows) {
      t.announcedAt = at
      t.announcePendingToken = null
      t.announcePendingAt = null
    }
    return rows.map((t) => t.id)
  }

  async reserveTaskAnnouncements(taskIds: string[], token: string, at: Date, staleBefore: Date): Promise<string[]> {
    this.fault('reserveTaskAnnouncements')
    const rows = this.tables.tasks.filter((t) =>
      taskIds.includes(t.id) && !t.announcedAt && t.deletedAt === null &&
      (!t.announcePendingToken || t.announcePendingToken === token ||
        (t.announcePendingAt !== null && t.announcePendingAt < staleBefore)))
    for (const t of rows) {
      t.announcePendingToken = token
      t.announcePendingAt = at
    }
    return rows.map((t) => t.id)
  }

  async confirmTaskAnnouncements(taskIds: string[], token: string, at: Date): Promise<void> {
    this.fault('confirmTaskAnnouncements')
    for (const t of this.tables.tasks) {
      if (taskIds.includes(t.id) && t.announcePendingToken === token && !t.announcedAt) {
        t.announcedAt = at
        t.announcePendingToken = null
        t.announcePendingAt = null
      }
    }
  }

  async releaseTaskAnnouncements(taskIds: string[]): Promise<void> {
    this.fault('releaseTaskAnnouncements')
    for (const t of this.tables.tasks) if (taskIds.includes(t.id)) t.announcedAt = null
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
    const t = this.tables.tasks.find((row) => row.id === y.taskId && row.deletedAt === null && row.status === y.fromStatus)
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
  async upsertGoogleAccount(a: NewGoogleAccount): Promise<void> {
    this.fault('upsertGoogleAccount')
    fk(this.hasLineUser(a.lineUserId), 'google_accounts.line_user_id')
    let row = this.tables.google_accounts.find((g) => g.googleSubject === a.googleSubject)
    if (row) {
      Object.assign(row, { ...a, grantedScopes: [...a.grantedScopes], tokenStatus: 'valid' })
    } else {
      row = { ...a, grantedScopes: [...a.grantedScopes], id: randomUUID(), tokenStatus: 'valid' }
      this.tables.google_accounts.push(row)
    }
    this.googleWrites.set(row.id, ++this.googleWriteSeq)
  }

  /** A user with several Google accounts gets the most recently written one. */
  async findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired' } | null> {
    this.fault('findGoogleAccountByLineUser')
    const rows = this.tables.google_accounts
      .filter((g) => g.lineUserId === lineUserId)
      .sort((a, b) => (this.googleWrites.get(b.id) ?? 0) - (this.googleWrites.get(a.id) ?? 0))
    return rows[0] ? { id: rows[0].id, tokenStatus: rows[0].tokenStatus } : null
  }

  // ---- Seed helpers (not on the port). They create the line_users rows they reference. ----
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
      assigneeLineUserId: null, dueAt: null, deletedAt: null, announcedAt: null, announcePendingAt: null,
      lastEditedByLineUserId: null, lastActivityAt: null, doneAt: null,
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
