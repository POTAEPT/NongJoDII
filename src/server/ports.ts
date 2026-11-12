import type { LineMessage } from './line/types'

// ---- LINE (Messaging API + LINE Login verify) ----
export interface LinePort {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>
  /** null when LINE answers 404 (the user is not in the group). */
  getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null>
  /** null when LINE rejects the ID token. */
  verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null>
}

// ---- OpenRouter ----
/** timeoutMs (optional) shortens the adapter's own timeout for this call, so a caller
 *  that makes several calls can keep them all inside the route's time budget. */
export type LlmRequest = { model: string; system: string; user: string; maxTokens: number; timeoutMs?: number }
export type LlmUsage = { inputTokens: number; outputTokens: number; costUsd: number | null }
export type LlmResult = { content: string; model: string; usage: LlmUsage | null }
export interface LlmPort { complete(req: LlmRequest): Promise<LlmResult> }

// ---- Google (OAuth now; Drive methods arrive with #13) ----
export type GoogleTokenResult = {
  refreshToken: string | null; scopes: string[]; subject: string | null; email: string | null
}
export interface GooglePort {
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<GoogleTokenResult>
}

// ---- Supabase ----
export type GroupRow = {
  id: string; lineGroupId: string; projectId: string | null; name: string | null
  nominatedOwnerLineUserId: string | null; ownerConfirmedAt: Date | null
  featureSummarize: boolean; featureDraftTasks: boolean; workDescription: string | null
  featureTrackRemind: boolean   // setup form: progress tracking, reminders, gap flags (#7, #8)
}
export type NewWebhookEvent = {
  webhookEventId: string; eventType: string; lineGroupId: string | null
  eventTimestamp: Date; isRedelivery: boolean
}
/** One LINE `message.mention.mentionees[]` entry. index and length count UTF-16 code
 *  units of `text` (the Messaging API's character unit), like JS string indices.
 *  userId is null when LINE left it out (type 'all', or no profile consent). */
export type MessageMention = { index: number; length: number; type: 'user' | 'all'; userId: string | null }
export type NewMessage = {
  groupId: string; webhookEventId: string; lineMessageId: string
  senderLineUserId: string | null; messageType: string; text: string | null; sentAt: Date
  imageSetId: string | null; imageSetIndex: number | null; imageSetTotal: number | null
  mentions: MessageMention[] | null   // null when the message tags nobody
}
export type StoredMessage = {
  id: string; senderLineUserId: string | null; senderDisplayName: string | null; text: string; sentAt: Date
  mentions: MessageMention[] | null
}
export type Member = { lineUserId: string; displayName: string | null; nicknames: string[]; role: string | null }
export type Membership = 'live' | 'left' | 'none'
export type NewSummary = {
  groupId: string; requestedByLineUserId: string | null; summaryText: string
  firstMessageAt: Date | null; lastMessageAt: Date | null
  createdAt: Date   // deps.now(); candidate i gets created_at = createdAt + i ms (stable order, M2)
}
export type NewCandidate = {
  title: string; details: string | null; suggestedAssigneeLineUserId: string | null; suggestedDueAt: Date | null
}
export type CandidateState = 'proposed' | 'confirmed' | 'declined'
export type CandidateRow = NewCandidate & { id: string; summaryId: string; state: CandidateState }
export type SummaryRow = { id: string; groupId: string; lineGroupId: string; summaryText: string; createdAt: Date }
export type TaskStatus = 'not_assigned' | 'in_process' | 'done'
export type NewTask = {
  groupId: string; candidateId: string; title: string; details: string | null; status: TaskStatus
  assigneeLineUserId: string | null; createdByLineUserId: string; dueAt: Date | null
}
export type TaskRow = {
  id: string; groupId: string; lineGroupId: string; candidateId: string | null; title: string
  details: string | null; status: TaskStatus; assigneeLineUserId: string | null
  createdByLineUserId: string; dueAt: Date | null; deletedAt: Date | null
}
export type TaskPatch = {
  title: string; details: string | null; assigneeLineUserId: string | null; status: TaskStatus
  dueAt: Date | null; lastEditedByLineUserId: string; lastActivityAt: Date
}
export type AiPurpose = 'summary' | 'progress_decision'
export type NewAiUsage = {
  ownerLineUserId: string; projectId: string | null; groupId: string | null; purpose: AiPurpose
  model: string; inputTokens: number; outputTokens: number; costUsd: number; createdAt: Date
}
/** The Fair-use cap the claim is checked against (FAIR_USE_* in usage/fair-use.ts). */
export type AiUsageCap = { capTokens: number; capCostUsd: number }
export type AiUsageActual = { model: string; inputTokens: number; outputTokens: number; costUsd: number }
// #7 Track progress: a mark_done card (task_prompts row) asks whether a Task moved
// to In Process or Done. Only a person's Yes moves the Task.
export type ProgressTarget = 'in_process' | 'done'
export type ProgressAnswer = 'yes' | 'no'
export type NewProgressPrompt = {
  groupId: string; taskId: string; targetStatus: ProgressTarget
  subjectLineUserId: string | null   // sender of the progress line; may answer besides the assignee
  triggerMessageId: string | null    // messages.id
  askedAt: Date
}
export type ProgressPromptRow = NewProgressPrompt & {
  id: string; answer: ProgressAnswer | null; answeredByLineUserId: string | null; answeredAt: Date | null
}
export type MessageRef = { id: string; groupId: string; senderLineUserId: string | null; sentAt: Date }
/** A person's Yes on a card: the answer and the Task move are one transaction. */
export type ProgressYes = {
  promptId: string; taskId: string; fromStatus: TaskStatus; toStatus: ProgressTarget
  byLineUserId: string; assignTo: string | null; at: Date
}
export type ProgressYesOutcome = 'updated' | 'already_answered' | 'task_changed'
export type NewGoogleAccount = {
  lineUserId: string; googleSubject: string; email: string | null
  grantedScopes: string[]; refreshTokenCiphertext: string
}

export interface StorePort {
  // #1 webhook
  // Store-once methods: ON CONFLICT DO NOTHING RETURNING; empty result = duplicate = inserted false.
  recordWebhookEvent(e: NewWebhookEvent): Promise<{ inserted: boolean }>           // conflict target webhook_event_id
  upsertLineUser(u: { lineUserId: string; displayName: string | null }): Promise<void> // null name: insert-if-absent, never overwrites; name set: update
  findLineUser(lineUserId: string): Promise<{ lineUserId: string; displayName: string | null } | null>
  ensureGroup(lineGroupId: string): Promise<GroupRow>                                // insert-if-absent (line_group_id), return row
  getGroupById(groupId: string): Promise<GroupRow | null>
  touchGroupMember(groupId: string, lineUserId: string, source: 'message' | 'liff'): Promise<void> // insert-if-absent (group_id, line_user_id)
  getMembership(groupId: string, lineUserId: string): Promise<Membership>
  insertMessage(m: NewMessage): Promise<{ inserted: boolean; id: string | null }>   // conflict target webhook_event_id -> inserted false, id null
  // #15 Summary
  listRecentTextMessages(groupId: string, limit: number): Promise<StoredMessage[]>  // newest `limit`, returned oldest first
  listLiveMembers(groupId: string): Promise<Member[]>                               // left_at is null
  createSummary(s: NewSummary, candidates: NewCandidate[]): Promise<{ summaryId: string; candidateIds: string[] }>
  // #16 confirm / edit
  getSummary(summaryId: string): Promise<SummaryRow | null>
  listCandidates(summaryId: string): Promise<CandidateRow[]>                         // ordered by created_at, then id
  decideCandidate(candidateId: string, state: 'confirmed' | 'declined', decidedBy: string, decidedAt: Date): Promise<{ updated: boolean }> // only from 'proposed'
  /** One transaction (rpc confirm_candidate): locks the candidate, then creates its Task
   *  (ON CONFLICT (candidate_id) DO NOTHING; duplicate -> existing id) and marks a proposed
   *  candidate confirmed, decided by t.createdByLineUserId. A candidate already declined
   *  wins: no Task, outcome already_decided, taskId null. */
  confirmCandidate(t: NewTask, decidedAt: Date): Promise<{ outcome: 'created' | 'already_decided'; taskId: string | null }>
  getTask(taskId: string): Promise<TaskRow | null>
  updateTask(taskId: string, patch: TaskPatch): Promise<{ updated: boolean }> // only a non-deleted Task; updated false when none matched
  // #5 / #6 usage
  /** Serialized per Owner: sums the Owner's Bangkok month (open claims included) and, when it is
   *  below the cap in tokens and dollars, inserts an open claim row holding the estimate `u`.
   *  claimId null = cap reached, nothing inserted. */
  claimAiUsage(u: NewAiUsage, cap: AiUsageCap): Promise<{ claimId: string | null }>
  /** UPDATE by id with the real numbers and marks it settled; idempotent, never inserts. */
  settleAiUsage(claimId: string, actual: AiUsageActual): Promise<void>
  /** Deletes the claim row only while it is still open (the AI call failed). */
  releaseAiUsage(claimId: string): Promise<void>
  /** Reads the owner_monthly_usage view (one row per Owner per Bangkok month), so the
   *  PostgREST max_rows limit (1000, supabase/config.toml) can never truncate the sum. */
  sumOwnerMonthUsage(ownerLineUserId: string, monthStartBkk: string): Promise<{ tokens: number; costMicroUsd: number }> // monthStartBkk 'YYYY-MM-01'; integer micro-dollars
  claimFairUseNotice(n: { ownerLineUserId: string; groupId: string; monthStartBkk: string; kind: 'warn_80' }): Promise<{ inserted: boolean }> // ON CONFLICT (PK) DO NOTHING
  // #7 Track progress
  listOpenTasks(groupId: string): Promise<TaskRow[]>                                  // live (deleted_at null), status <> done, oldest first
  getMessageRef(messageId: string): Promise<MessageRef | null>
  findOpenProgressPrompt(taskId: string): Promise<ProgressPromptRow | null>           // kind mark_done, answer null
  /** Insert a mark_done card. prompt null when the Task already has an open one
   *  (unique index task_prompts_one_open_mark_done). */
  createProgressPrompt(p: NewProgressPrompt): Promise<{ prompt: ProgressPromptRow | null }>
  getProgressPrompt(promptId: string): Promise<ProgressPromptRow | null>
  /** No: only while the card is open (answer is null); the first answer wins. */
  answerProgressPrompt(promptId: string, answer: 'no', byLineUserId: string, at: Date): Promise<{ updated: boolean }>
  /** Yes, in one transaction (rpc answer_progress_yes): locks the card; if it is open and the
   *  live Task is still in fromStatus, moves the Task (done sets done_at; assignTo, when set,
   *  becomes the assignee; bumps last_activity_at and last_edited_by) and records the answer.
   *  task_changed leaves the card open and the Task untouched. */
  confirmProgressYes(y: ProgressYes): Promise<{ outcome: ProgressYesOutcome }>
  /** Deletes a card only while it is unanswered: its reply never reached the group, or it went stale. */
  withdrawProgressPrompt(promptId: string): Promise<void>
  // #12 Google
  upsertGoogleAccount(a: NewGoogleAccount): Promise<void>                            // conflict on google_subject: update, token_status 'valid'
  findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired' } | null>
}

// ---- Composition ----
export type HandlerConfig = { lineChannelSecret: string; liffId: string; tokenEncryptionKey: Buffer }
export type Deps = {
  line: LinePort; llm: LlmPort; google: GooglePort; store: StorePort
  now: () => Date; config: HandlerConfig
}
export type Defer = (job: () => Promise<void>) => void
export type ApiResult = { status: number; body: unknown }
