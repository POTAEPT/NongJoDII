import type { LineMessage } from './line/types'

// ---- LINE (Messaging API + LINE Login verify) ----
/** 'sent': LINE accepted the push now. 'duplicate': it had already accepted one with the
 *  same retry key and sent nothing this time. */
export type LinePushResult = 'sent' | 'duplicate'
export interface LinePort {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>
  /** Push to a LINE group ID. Unlike a reply, a push counts against the monthly
   *  LINE quota (#25). Groups only: no 1:1 pushes (rules: Scheduling and pushes).
   *  'duplicate': LINE had already accepted a push with this retry key (409), so this
   *  call sent nothing. Rejects with LinePushRejected when LINE refused the push (another
   *  4xx: nothing was sent); any other rejection leaves the outcome unknown. */
  push(to: string, messages: LineMessage[], opts?: { retryKey?: string }): Promise<LinePushResult>
  /** null when LINE answers 404 (the user is not in the group). */
  getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null>
  /** People in the group per LINE (GET /v2/bot/group/{id}/members/count). Excludes the
   *  bot. LINE charges a group push once per member, so this is the push's real cost. */
  getGroupMemberCount(lineGroupId: string): Promise<number>
  /** The group's name per LINE (GET /v2/bot/group/{id}/summary); null on a 404. */
  getGroupSummary(lineGroupId: string): Promise<{ groupName: string } | null>
  /** null when LINE rejects the ID token. */
  verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null>
  /** This month's push budget: limit null = no limit; used = messages counted so far. */
  getMessageQuota(): Promise<{ limit: number | null; used: number }>
}

// ---- OpenRouter ----
/** timeoutMs (optional) shortens the adapter's own timeout for this call, so a caller
 *  that makes several calls can keep them all inside the route's time budget. */
export type LlmRequest = { model: string; system: string; user: string; maxTokens: number; timeoutMs?: number }
export type LlmUsage = { inputTokens: number; outputTokens: number; costUsd: number | null }
export type LlmResult = { content: string; model: string; usage: LlmUsage | null }
export interface LlmPort { complete(req: LlmRequest): Promise<LlmResult> }

// ---- Google (OAuth #12, Drive folders #13) ----
export type GoogleTokenResult = {
  refreshToken: string | null; scopes: string[]; subject: string | null; email: string | null
}
/** What Drive says about a stored folder ID: 'trashed' counts as deleted (#13). */
export type DriveFolderState = 'ok' | 'trashed' | 'missing'
export interface GooglePort {
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<GoogleTokenResult>
  /** A short-lived access token from the stored refresh token. Rejects with
   *  GoogleTokenRevoked when Google answers invalid_grant (revoked or expired grant). */
  accessToken(refreshToken: string): Promise<string>
  /** Creates a folder under parentId (null = the Drive's root); returns its ID. */
  createFolder(accessToken: string, name: string, parentId: string | null): Promise<string>
  /** 'missing' when Drive answers 404. */
  getFolder(accessToken: string, folderId: string): Promise<DriveFolderState>
  /** "Anyone with the link can view" (permissions.create role reader, type anyone). */
  shareAnyoneReader(accessToken: string, fileId: string): Promise<void>
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
  announcedAt: Date | null   // when the group was told about it (null = not yet)
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
/** What a push is for; stored in push_log.purpose (free text in the schema). */
export type PushPurpose = 'task_created' | 'weekly_insight' | 'reminder' | 'setup_done' | 'drive_revoked'
export type PushBudgetClaim = {
  purpose: PushPurpose; lineTargetId: string; messageCount: number
  lineUsed: number   // LINE's figure for this month
  allowed: number    // most the month may reach with this push
}
/** One "Tasks created" push attempt: `token` is the new batch's id and LINE retry key;
 *  a claim whose announce_pending_at is before `staleBefore` belongs to a dead request. */
export type AnnounceClaim = { taskIds: string[]; token: string; at: Date; staleBefore: Date }
/** A set-up group (attached to a Project, bot still in it) with reminders on, and its
 *  daily slot: Bangkok time 'HH:MM:SS' and the Bangkok date it was last sent. */
export type DailyReminderGroup = { groupId: string; lineGroupId: string; time: string; lastSentOn: string | null }
/** A live Task as the daily reminder reads it (#44). */
export type ReminderTask = {
  id: string; title: string; status: TaskStatus
  assigneeLineUserId: string | null; dueAt: Date | null
  lastActivityAt: Date | null; deletedAt: Date | null
}
/** A set-up group (attached to a Project, bot still in it) with the weekly summary on,
 *  and its chosen slot: ISO weekday 1..7, Bangkok time 'HH:MM:SS', last sent Bangkok date. */
export type WeeklySummaryGroup = {
  groupId: string; lineGroupId: string; weekday: number; time: string; lastSentOn: string | null
}
/** Live (not soft-deleted) Tasks of one group by status. "Awaiting an owner" = Not Assigned. */
export type TaskCounts = { done: number; inProcess: number; awaitingOwner: number }
export type UnownedTask = { id: string; title: string; dueAt: Date | null }
export type NewWeeklyInsight = {
  groupId: string; weekStart: string   // Monday, 'YYYY-MM-DD' Bangkok
  counts: TaskCounts; createdAt: Date
}
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
// #52 onboarding: the setup form (Figma v4 #2b-#2d2) and the Owner confirm.
/** The feature toggles of groups. The form's first checkbox sets summarize and draftTasks together. */
export type GroupFeatures = {
  summarize: boolean; draftTasks: boolean; saveFiles: boolean; trackRemind: boolean; weeklySummary: boolean
}
/** What the setup form reads. Times are Bangkok 'HH:MM'; weekday ISO 1..7. */
export type GroupSetup = {
  groupId: string; lineGroupId: string; name: string | null; projectId: string | null
  workDescription: string | null; features: GroupFeatures
  dailyReminderTime: string; weeklySummaryWeekday: number; weeklySummaryTime: string
  nominatedOwnerLineUserId: string | null; ownerConfirmedAt: Date | null
  /** When the current nominee was named; a resend that keeps the nominee keeps it. */
  ownerNominatedAt: Date | null
}
export type SetupMemberWrite = { lineUserId: string; nicknames: string[]; role: string | null }
export type GroupSetupWrite = {
  groupId: string; byLineUserId: string; workDescription: string | null; features: GroupFeatures
  dailyReminderTime: string; weeklySummaryWeekday: number; weeklySummaryTime: string
  members: SetupMemberWrite[]; ownerLineUserId: string; at: Date
}
/** 'closed': the group has a confirmed Owner or already belongs to a Project. */
export type SetupOutcome = 'confirmed' | 'pending' | 'closed' | 'owner_not_member'
export type OwnerConfirmOutcome = 'confirmed' | 'already_confirmed' | 'not_nominee' | 'not_member' | 'closed'
export type NewGoogleAccount = {
  lineUserId: string; googleSubject: string; email: string | null
  grantedScopes: string[]; refreshTokenCiphertext: string
  /** When this sign-in finished: stored as google_accounts.connected_at (#14). */
  signedInAt: Date
}

/** A group that gets a Drive folder: attached, Owner confirmed, bot still in it. */
export type DriveGroup = { groupId: string; lineGroupId: string; name: string | null; folderId: string | null }
/** What #13 reads to lay out a Project's folders. `account` is the Owner's latest Google
 *  account (the last one to sign in); `activeAccountId` the account of the Project's active
 *  Drive connection (null = none yet). */
export type DriveContext = {
  projectId: string; ownerLineUserId: string; projectFolderId: string | null
  mainGroup: DriveGroup | null; subGroups: DriveGroup[]
  account: {
    id: string; tokenStatus: 'valid' | 'revoked' | 'expired'
    refreshTokenCiphertext: string | null; rootFolderId: string | null
  } | null
  activeAccountId: string | null
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
  // #24 unsend
  /** Deletes the stored message with this LINE message id. deleted false when no row had it
   *  (never stored, or already deleted), so a repeat is harmless. Rows that point at it
   *  (task_prompts.trigger_message_id, files.message_id) are kept by ON DELETE SET NULL. */
  deleteMessageByLineId(lineMessageId: string): Promise<{ deleted: boolean }>
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
  // tasks.announce_pending_token / announce_pending_at now carry the bot's batch token
  // (the comment in applied migration 20261112171952 describes an older page-token use).
  /** Claims Tasks for one "Tasks created" push attempt (#16). A batch released after a
   *  failed push, or whose claim went stale (its request died), is re-claimed whole by
   *  its token: every live, unannounced row holding that token, including rows not in
   *  taskIds. The token is kept, so the retry reuses the LINE retry key. Live,
   *  unannounced rows of taskIds with no token get c.token. Rows with a live claim,
   *  announced rows and deleted rows are left alone. Returns every row this call now
   *  holds, with its token. */
  claimTaskAnnouncements(c: AnnounceClaim): Promise<{ taskId: string; token: string }[]>
  /** LINE accepted the push of batch `token`: announced_at = at, token and pending_at
   *  cleared (rows with announced_at null only). */
  confirmTaskAnnouncements(token: string, at: Date): Promise<void>
  /** The push of batch `token` failed or its outcome is unknown: pending_at = null,
   *  token kept, so the next claim retries the same batch with the same retry key.
   *  Only rows still held by this claim (announce_pending_at = claimedAt, the `at` it
   *  wrote): a stale re-claim by another request rewrote pending_at and is left alone. */
  releaseTaskAnnouncements(token: string, claimedAt: Date): Promise<void>
  /** Batch `token` was never pushed under its token: token and pending_at cleared
   *  (rows with announced_at null only), so its Tasks are claimed fresh next time.
   *  Scoped to this claim by claimedAt, like release. */
  abandonTaskAnnouncements(token: string, claimedAt: Date): Promise<void>
  /** rpc claim_push_budget: serialized; counts recent push_log rows on top of
   *  lineUsed and inserts this push's row when the total stays within `allowed`.
   *  null = no budget, nothing inserted. */
  claimPushBudget(c: PushBudgetClaim): Promise<{ pushLogId: string | null }>
  /** Deletes a claimed push_log row whose push sent nothing (LINE refused it, or it was
   *  a duplicate of an accepted push). */
  releasePushBudget(pushLogId: string): Promise<void>
  listTasksByCandidates(candidateIds: string[]): Promise<TaskRow[]>
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
  // #20 weekly insight
  /** groups where project_id is not null, left_at is null, feature_weekly_summary and
   *  weekly_summary_weekday = `weekday` (ISO 1..7). Every page, ordered by id. */
  listWeeklySummaryGroups(weekday: number): Promise<WeeklySummaryGroup[]>
  /** One statement: sets weekly_summary_last_sent_on = todayBkk where it is null or before
   *  todayBkk. claimed false = another tick already took today's slot. */
  claimWeeklySummary(groupId: string, todayBkk: string): Promise<{ claimed: boolean }>
  /** Undoes a claim after a failure, so a later tick retries: puts back `previous` only
   *  while the column still holds todayBkk. */
  releaseWeeklySummary(groupId: string, todayBkk: string, previous: string | null): Promise<void>
  countTasksByStatus(groupId: string): Promise<TaskCounts>                          // deleted_at is null
  /** Live Not Assigned Tasks, oldest first, at most `limit`. */
  listUnownedTasks(groupId: string, limit: number): Promise<UnownedTask[]>
  /** ON CONFLICT (group_id, week_start) DO NOTHING; inserted false = this week already has one. */
  saveWeeklyInsight(i: NewWeeklyInsight): Promise<{ inserted: boolean }>
  hasWeeklyInsight(groupId: string, weekStart: string): Promise<boolean>
  /** #21: sets posted_at once the group post went out (only while it is still null). */
  markWeeklyInsightPosted(groupId: string, weekStart: string, at: Date): Promise<void>
  // #44 daily reminders and gap flags
  /** groups where project_id is not null, left_at is null and feature_track_remind. Every page, by id. */
  listDailyReminderGroups(): Promise<DailyReminderGroup[]>
  /** One statement: sets daily_reminder_claimed_at = at where daily_reminder_last_sent_on is
   *  null or before todayBkk and no claim younger than `staleBefore` holds the group. The
   *  claim expires on its own, so a request that dies mid-attempt never blocks the day. */
  claimDailyReminder(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }>
  /** Marks the day complete (daily_reminder_last_sent_on = todayBkk) and clears the claim,
   *  only while the claim made `at` still holds the group. */
  finishDailyReminder(groupId: string, todayBkk: string, at: Date): Promise<void>
  /** Clears the claim made `at` without completing the day, so the next tick retries. */
  releaseDailyReminder(groupId: string, at: Date): Promise<void>
  /** The group's live Tasks that are not Done, oldest first. */
  listReminderTasks(groupId: string): Promise<ReminderTask[]>
  // #45 answers to reminder cards. Each is one UPDATE whose WHERE holds the precondition,
  // so two presses at once cannot both win; updated false = the Task no longer qualifies.
  /** "เสร็จแล้ว": status done, done_at, last_activity_at, last_edited_by; only a live Task not Done whose assignee is still `by`. */
  markTaskDone(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }>
  /** "เลื่อนกำหนด": new due_at, bumps last_activity_at and last_edited_by; only a live Task not Done whose assignee is still `by`. */
  postponeTask(t: { taskId: string; dueAt: Date; by: string; at: Date }): Promise<{ updated: boolean }>
  /** "ฉันรับเอง": assignee = by and In Process; only a live Task not Done that has no assignee. */
  takeTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }>
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
   *  The presser must still be the Task's assignee or the card's subject at write time, else
   *  task_changed (a reassignment can land between the handler's check and this write).
   *  task_changed leaves the card open and the Task untouched. */
  confirmProgressYes(y: ProgressYes): Promise<{ outcome: ProgressYesOutcome }>
  /** Deletes a card only while it is unanswered: its reply never reached the group, or it went stale. */
  withdrawProgressPrompt(promptId: string): Promise<void>
  // #52 onboarding
  setGroupName(groupId: string, name: string): Promise<void>
  getGroupSetup(groupId: string): Promise<GroupSetup | null>
  /** One transaction (rpc setup_group): locks the group; a 'closed' group or an Owner who
   *  is not a live Member saves nothing. Otherwise writes the settings and the nominee,
   *  updates nicknames and role of the listed live Members only (never their source), and,
   *  when the sender named themselves, confirms them and creates the Project as
   *  confirmGroupOwner does. */
  saveGroupSetup(s: GroupSetupWrite): Promise<{ outcome: SetupOutcome }>
  /** One transaction (rpc confirm_group_owner): only the nominee, while a live Member,
   *  confirms; this creates the Project (owner = the nominee) with the group as its main
   *  group. A repeat by the confirmed Owner answers already_confirmed and changes nothing. */
  confirmGroupOwner(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerConfirmOutcome }>
  // #12 Google
  /** Conflict on google_subject: update, token_status 'valid'. Every sign-in sets
   *  connected_at = signedInAt, so a person's latest account is the one that signed in
   *  last, whatever else wrote to the rows since (#14). Answers the row's ID. */
  upsertGoogleAccount(a: NewGoogleAccount): Promise<{ id: string }>
  /** The person's latest account: connected_at DESC. */
  findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired' } | null>
  /** #14: one UPDATE that sets token_status 'revoked' and clears the refresh token, only
   *  while the row is still 'valid' and still holds `refreshTokenCiphertext` (the token
   *  Google refused). revoked: this call changed the row. So one caller per revocation gets
   *  true, and a sign-in that stored a new token in between is left alone. */
  markGoogleAccountRevoked(googleAccountId: string, refreshTokenCiphertext: string): Promise<{ revoked: boolean }>
  // #13 Drive folders
  /** IDs of the Projects whose main group has this person as its confirmed Owner (bot still
   *  in it). Every page, by group id. */
  listConfirmedOwnerProjects(lineUserId: string): Promise<string[]>
  /** null when the Project does not exist. Groups: confirmed Owner and left_at null only,
   *  every page, by id. */
  getDriveContext(projectId: string): Promise<DriveContext | null>
  // Folder ID setters are compare-and-set: they write `to` only while the column still
  // holds `from` (null = empty), so two runs at once keep one ID. Each returns the ID the
  // column holds afterwards (the other run's, when it got in first).
  setDriveRootFolder(googleAccountId: string, from: string | null, to: string): Promise<{ folderId: string | null }>
  setProjectDriveFolder(projectId: string, from: string | null, to: string): Promise<{ folderId: string | null }>
  setGroupDriveFolder(groupId: string, from: string | null, to: string): Promise<{ folderId: string | null }>
  /** The lock that binds a Project's folders to one Google account: the Project's active
   *  drive_connections row (unique index drive_connections_one_active). Inserts it for
   *  `googleAccountId` unless one exists, then answers the account that holds it (on a
   *  23505 it reads the holder again). created: this call inserted the row. Never updates
   *  or deletes a row. */
  claimDriveConnection(projectId: string, googleAccountId: string): Promise<{ created: boolean; accountId: string }>
  /** #14, change of account: when the Project's active drive_connections row belongs to
   *  another Google account than `keepGoogleAccountId`, clears the folder IDs
   *  (projects.drive_project_folder_id, and groups.drive_folder_id of every group of the
   *  Project), then marks that row 'replaced' with status_changed_at = `at`, the same way
   *  change_project_owner retires a connection. The row is never deleted or re-pointed, so
   *  it stays as history for the files saved through it. No active row, or one of
   *  `keepGoogleAccountId`: writes nothing. retired: this call retired the row.
   *  Separate statements, cleared first and retired last: a call that stopped part-way
   *  leaves the row active, so the same call again finishes it. */
  retireDriveConnection(projectId: string, keepGoogleAccountId: string, at: Date): Promise<{ retired: boolean }>
  /** The tick finisher's Projects, by id: Drive setups that have not finished. A Project is
   *  listed when its main group has a confirmed Owner and the bot, a folder ID is still
   *  empty (the Project folder, or a group that getDriveContext lists: confirmed Owner, bot
   *  still in it), the Owner's latest Google account (connected_at) is valid and no other
   *  account holds the active drive_connections row, and the later of the Owner confirm
   *  (owner_confirmed_at) and that account's updated_at lies in [from, to]. updated_at
   *  moves on every sign-in, and also when the root folder ID is stored. */
  listUnfinishedDriveProjects(from: Date, to: Date): Promise<string[]>
}

// ---- Composition ----
export type HandlerConfig = { lineChannelSecret: string; liffId: string; tokenEncryptionKey: Buffer; tickSecret: string }
export type Deps = {
  line: LinePort; llm: LlmPort; google: GooglePort; store: StorePort
  now: () => Date; config: HandlerConfig
}
export type Defer = (job: () => Promise<void>) => void
export type ApiResult = { status: number; body: unknown }
