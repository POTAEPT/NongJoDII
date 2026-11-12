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
export type LlmRequest = { model: string; system: string; user: string; maxTokens: number }
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
}
export type NewWebhookEvent = {
  webhookEventId: string; eventType: string; lineGroupId: string | null
  eventTimestamp: Date; isRedelivery: boolean
}
export type NewMessage = {
  groupId: string; webhookEventId: string; lineMessageId: string
  senderLineUserId: string | null; messageType: string; text: string | null; sentAt: Date
  imageSetId: string | null; imageSetIndex: number | null; imageSetTotal: number | null
}
export type StoredMessage = {
  id: string; senderLineUserId: string | null; senderDisplayName: string | null; text: string; sentAt: Date
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
export type AiPurpose = 'summary'
export type NewAiUsage = {
  ownerLineUserId: string; projectId: string | null; groupId: string | null; purpose: AiPurpose
  model: string; inputTokens: number; outputTokens: number; costUsd: number; createdAt: Date
}
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
  createTask(t: NewTask): Promise<{ created: boolean; taskId: string }>              // ON CONFLICT (candidate_id) DO NOTHING; duplicate -> existing id, created false
  getTask(taskId: string): Promise<TaskRow | null>
  updateTask(taskId: string, patch: TaskPatch): Promise<{ updated: boolean }> // only a non-deleted Task; updated false when none matched
  // #5 / #6 usage
  insertAiUsage(u: NewAiUsage): Promise<void>
  /** Reads the owner_monthly_usage view (one row per Owner per Bangkok month), so the
   *  PostgREST max_rows limit (1000, supabase/config.toml) can never truncate the sum. */
  sumOwnerMonthUsage(ownerLineUserId: string, monthStartBkk: string): Promise<{ tokens: number; costMicroUsd: number }> // monthStartBkk 'YYYY-MM-01'; integer micro-dollars
  claimFairUseNotice(n: { ownerLineUserId: string; groupId: string; monthStartBkk: string; kind: 'warn_80' }): Promise<{ inserted: boolean }> // ON CONFLICT (PK) DO NOTHING
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
