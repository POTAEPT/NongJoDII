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
  /** #4: the bytes of an image or file a user sent (GET api-data.line.me/v2/bot/message/{id}/content).
   *  null when LINE answers 404 (the content is gone). `timeoutMs` cuts the whole call, body
   *  included, so a big file cannot run past the route's limit. contentType: LINE's
   *  Content-Type header, null when absent. Rejects with ContentTooLarge when the content
   *  is bigger than `maxBytes` (by Content-Length, or while reading). */
  getMessageContent(
    messageId: string, opts: { timeoutMs: number; maxBytes: number },
  ): Promise<{ data: Uint8Array; contentType: string | null } | null>
  /** The bot leaves the group (POST /v2/bot/group/{id}/leave, #11). 'left': LINE answered
   *  200. 'not_in_group': LINE answered 404, so the bot is not in the group (it was removed,
   *  or an earlier leave went through and its answer was lost). Rejects on anything else
   *  (another 4xx, a 5xx, a timeout): the bot may still be in the group. */
  leaveGroup(lineGroupId: string): Promise<'left' | 'not_in_group'>
}

// ---- OpenRouter ----
/** timeoutMs (optional) shortens the adapter's own timeout for this call, so a caller
 *  that makes several calls can keep them all inside the route's time budget. */
/** schema (#111): a JSON Schema the answer must follow (OpenRouter structured outputs, strict).
 *  Without it the adapter asks only for a JSON object. */
export type LlmRequest = {
  model: string; system: string; user: string; maxTokens: number; timeoutMs?: number
  schema?: { name: string; schema: Record<string, unknown> }
}
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
  /** #4: whether the folder has the "anyone with the link" permission (Drive gives it the
   *  permission ID 'anyoneWithLink'). */
  folderShared(accessToken: string, folderId: string): Promise<boolean>
  /** #4: uploads a file into `parentId` (files.create with media); it inherits the folder's
   *  sharing. `timeoutMs` cuts the whole upload. Returns Drive's id and webViewLink. */
  uploadFile(accessToken: string, f: DriveUpload, opts: { timeoutMs: number }): Promise<{ id: string; webViewLink: string }>
  /** #82: revokes the grant behind a refresh token (POST oauth2.googleapis.com/revoke).
   *  'invalid': Google answered 400 (the token is already revoked or expired). Throws on any
   *  other failure (5xx, timeout), so nothing is changed and the person can try again. */
  revokeToken(refreshToken: string): Promise<'revoked' | 'invalid'>
}
export type DriveUpload = { name: string; parentId: string; mimeType: string; data: Uint8Array }

// ---- Supabase ----
export type GroupRow = {
  id: string; lineGroupId: string; projectId: string | null; name: string | null
  nominatedOwnerLineUserId: string | null; ownerConfirmedAt: Date | null
  featureSummarize: boolean; featureDraftTasks: boolean; workDescription: string | null
  featureTrackRemind: boolean   // setup form: progress tracking, reminders, gap flags (#7, #8)
  /** #30: when the confirmed Owner left this group; null otherwise. While set, file saving,
   *  Summaries and the weekly insight pause (owner_confirmed_at is null too). */
  ownerLeftAt: Date | null
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
/** #33: what a quote-reply's quotedMessageId leads to in this group. 'no_message': the bot
 *  has no stored copy (never stored, another group's, or unsent and deleted by #24).
 *  'no_file': a stored message with no files row. 'file': the newest saved file for it. */
export type QuotedFileLookup =
  | { kind: 'no_message' }
  | { kind: 'no_file' }
  | { kind: 'file'; fileName: string; driveLink: string }
/** #4: a files row. messageId: the stored message it was last sent in (null after an unsend). */
export type SavedFile = {
  id: string; groupId: string; messageId: string | null; fileName: string; driveLink: string; driveFileId: string
  sizeBytes: number | null
}
export type NewFile = {
  groupId: string; messageId: string; senderLineUserId: string | null; driveConnectionId: string
  fileName: string; contentSha256: string; driveFileId: string; driveLink: string; sentAt: Date
  savedAt: Date; sizeBytes: number
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
  /** #109: the model's tags for it (tasks/tags.ts rules), empty when none. */
  suggestedTags: string[]
}
export type CandidateState = 'proposed' | 'confirmed' | 'declined'
export type CandidateRow = NewCandidate & { id: string; summaryId: string; state: CandidateState }
export type SummaryRow = { id: string; groupId: string; lineGroupId: string; summaryText: string; createdAt: Date }
export type TaskStatus = 'not_assigned' | 'in_process' | 'done'
export type NewTask = {
  groupId: string; candidateId: string; title: string; details: string | null; status: TaskStatus
  assigneeLineUserId: string | null; createdByLineUserId: string; dueAt: Date | null
  /** #109: the tags the person confirmed. */
  tags: string[]
}
export type TaskRow = {
  id: string; groupId: string; lineGroupId: string; candidateId: string | null; title: string
  details: string | null; status: TaskStatus; assigneeLineUserId: string | null
  createdByLineUserId: string; dueAt: Date | null; deletedAt: Date | null
  announcedAt: Date | null   // when the group was told about it (null = not yet)
  tags: string[]             // #109
}
export type TaskPatch = {
  title: string; details: string | null; assigneeLineUserId: string | null; status: TaskStatus
  dueAt: Date | null; lastEditedByLineUserId: string; lastActivityAt: Date
  tags: string[]             // #109
}
// #17 Dashboard read. Names are LINE names (line_users.display_name), never nicknames.
/** One of the requester's group_members rows, for a group that is in a Project and still
 *  has the bot. `left` = left_at is set. isPm = group_members.is_pm. */
export type DashboardMembership = {
  groupId: string; projectId: string; projectOwnerLineUserId: string; isPm: boolean; left: boolean
}
/** #84: one group in the 1:1 chat menu. */
export type UserGroup = { groupId: string; name: string | null; isOwner: boolean }
/** ownerLineUserId (#90): the group's confirmed Owner, or null while none is confirmed. */
export type DashboardGroupRow = { groupId: string; projectId: string; name: string | null; ownerLineUserId: string | null }
export type DashboardMemberRow = { groupId: string; lineUserId: string; displayName: string | null }
/** A live (not soft-deleted) Task; assigneeName is kept for a Member who left (Done Tasks keep the name). */
export type DashboardTaskRow = {
  id: string; groupId: string; title: string; status: TaskStatus
  assigneeLineUserId: string | null; assigneeName: string | null; dueAt: Date | null
  tags: string[]             // #109
}
export type DashboardFileRow = {
  id: string; groupId: string; fileName: string; driveLink: string; sizeBytes: number | null
  savedAt: Date; senderName: string | null
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
export type PushPurpose =
  | 'task_created' | 'weekly_insight' | 'reminder' | 'setup_done' | 'drive_revoked' | 'member_left'
  | 'owner_takeover' | 'subgroup_detached'   // #31
  | 'owner_needed'                           // #30
  | 'file_saved' | 'file_failed' | 'drive_share_refused'   // #4
  | 'drive_disconnected'                     // #82
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
/** #32: a group the bot is still in, for the daily member check,
 *  with the Bangkok date its check last completed. */
export type MemberCheckGroup = { groupId: string; lineGroupId: string; lastCheckedOn: string | null }
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
/** #22: a group's latest saved weekly insight, for the Dashboard. postedAt null: never posted
 *  in the group (skipped near the LINE quota, failed, or no Tasks to post). */
export type LatestWeeklyInsight = {
  groupId: string; weekStart: string; counts: TaskCounts; postedAt: Date | null
}
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
export type MessageRef = {
  id: string; groupId: string; senderLineUserId: string | null; sentAt: Date
  /** #7: set once someone pressed "ไม่ใช่การอัปเดตงาน" on this message's picker; its picks are then refused. */
  progressDismissedAt: Date | null
}
/** A person's Yes on a card: the answer and the Task move are one transaction. */
export type ProgressYes = {
  promptId: string; taskId: string; fromStatus: TaskStatus; toStatus: ProgressTarget
  byLineUserId: string; assignTo: string | null; at: Date
}
/** dismissed: the card's chat message was marked "ไม่ใช่การอัปเดตงาน" (#87); nothing changed. */
export type ProgressYesOutcome = 'updated' | 'already_answered' | 'task_changed' | 'dismissed'
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
  /** #30: when the confirmed Owner left; set while the group needs a new Owner. */
  ownerLeftAt: Date | null
  /** #110: the group's starting tags (groups.tag_set). */
  tagSet: string[]
}
export type SetupMemberWrite = { lineUserId: string; nicknames: string[]; role: string | null }
/** #28 Settings: the setup form's values, written by the group's confirmed Owner. */
export type GroupSettingsWrite = {
  groupId: string; ownerLineUserId: string; workDescription: string | null; features: GroupFeatures
  dailyReminderTime: string; weeklySummaryWeekday: number; weeklySummaryTime: string; members: SetupMemberWrite[]
  tagSet: string[]   // #110
}
export type GroupSetupWrite = {
  groupId: string; byLineUserId: string; workDescription: string | null; features: GroupFeatures
  dailyReminderTime: string; weeklySummaryWeekday: number; weeklySummaryTime: string
  members: SetupMemberWrite[]; ownerLineUserId: string; at: Date
  tagSet: string[]   // #110
}
/** 'closed': the group has a confirmed Owner or already belongs to a Project. */
export type SetupOutcome = 'confirmed' | 'pending' | 'closed' | 'owner_not_member'
export type OwnerConfirmOutcome = 'confirmed' | 'already_confirmed' | 'not_nominee' | 'not_member' | 'closed'
/** #30, a live Member presses the owner_needed card. claimed: they are now the main group's
 *  nominee. already_claimed: they already were. taken: another live Member holds the
 *  nomination. not_pending: no Owner change is pending. not_main_group: the Owner left a Sub
 *  group, whose Owner must stay the Project's owner (check_same_owner). */
export type OwnerClaimOutcome = 'claimed' | 'already_claimed' | 'taken' | 'not_pending' | 'not_main_group'
/** #30, rpc complete_owner_change (migration 20261115130000). */
export type CompleteOwnerChangeOutcome = 'changed' | 'already_owner' | 'not_pending' | 'not_nominee' | 'not_member' | 'needs_drive'
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

// #31 Project Owner change: the Sub group take-over question.
/** A Sub group whose take-over question is unanswered (groups.takeover_asked_at set). */
export type TakeoverSubGroup = { groupId: string; lineGroupId: string; name: string | null; askedAt: Date }
/** A Project as the take-over question reads it. mainGroup null: no main group row. */
export type OwnerChangeState = {
  projectId: string; ownerLineUserId: string
  mainGroup: {
    groupId: string; lineGroupId: string; name: string | null
    nominatedOwnerLineUserId: string | null; ownerConfirmedAt: Date | null
  } | null
  /** Waiting Sub groups, by id. */
  waiting: TakeoverSubGroup[]
}
/** A Sub group the daily rule detached from its Project. */
export type PausedOwnerCard = {
  groupId: string; lineGroupId: string; ownerLineUserId: string | null
  card: { promptId: string; askedAt: Date; pushed: boolean } | null
}
export type DetachedSubGroup = { groupId: string; lineGroupId: string; name: string | null }
/** #30 part B: a group that has had no Owner since ownerLeftAt. subGroup: attached to a
 *  Project and not its main group (it detaches instead of the bot leaving). */
export type OwnerlessGroup = {
  groupId: string; lineGroupId: string; subGroup: boolean; nominatedOwnerLineUserId: string | null
  ownerLeftAt: Date; joinedAt: Date | null
}
/** #30 part B: what the exit job checks again right before it acts on a group. */
export type OwnerExitState = {
  ownerConfirmedAt: Date | null; ownerLeftAt: Date | null; leftAt: Date | null; joinedAt: Date | null; subGroup: boolean
  /** groups.owner_nominated_at: when the current nominee was named (a claim sets it). */
  ownerNominatedAt: Date | null
}
/** 'not_nominee': the main group does not name this person (change_project_owner raised). */
export type OwnerChangeOutcome = 'changed' | 'not_nominee'
/** 'changed': a chosen Sub group stopped waiting (expired and detached) while the answer
 *  was saved; nothing was written. */
/** 'expired': the Sub groups waited more than 7 days (TAKEOVER_WAIT_MS); the tick detaches
 *  them, so the answer is refused (answer_subgroup_takeover raises SQLSTATE NJ409 once
 *  20261116010000 is applied). */
export type TakeoverAnswerOutcome = 'saved' | 'changed' | 'expired'

export interface StorePort {
  // #1 webhook
  // Store-once methods: ON CONFLICT DO NOTHING RETURNING; empty result = duplicate = inserted false.
  recordWebhookEvent(e: NewWebhookEvent): Promise<{ inserted: boolean }>           // conflict target webhook_event_id
  /** Read only: is this event already in the ledger? (#29: a redelivered member event that
   *  already ran must not run its writes again.) */
  hasWebhookEvent(webhookEventId: string): Promise<boolean>
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
  // #24: keeps a tombstone of the LINE message ID and deletes the stored copy; a later insert of
  // that message ID stores nothing (insertMessage answers inserted false). deleted: a copy was there
  unsendMessage(lineMessageId: string): Promise<{ deleted: boolean }>
  // #33 file request by quote-reply
  /** The stored message with this LINE message id in this group (never another group's),
   *  then the newest files row whose message_id points at it. */
  findQuotedFile(groupId: string, lineMessageId: string): Promise<QuotedFileLookup>
  // #4 file saver
  /** The files row of this group with this content hash (unique files_one_per_hash), or null. */
  findFileByHash(groupId: string, contentSha256: string): Promise<SavedFile | null>
  /** INSERT ... ON CONFLICT (group_id, content_sha256) DO NOTHING. inserted false: another
   *  save of the same content got in first; `file` is then that row. */
  insertFile(f: NewFile): Promise<{ inserted: boolean; file: SavedFile }>
  /** A re-sent file (same hash): points the row's message_id at the newest message that
   *  carried it, so a quote-reply to that message (#33) finds the link. updated false when
   *  the row is gone (group purged). */
  linkFileToMessage(fileId: string, messageId: string): Promise<{ updated: boolean }>
  /** The Project's active drive_connections row, or null. */
  findActiveDriveConnection(projectId: string): Promise<{ id: string; googleAccountId: string } | null>
  /** A photo batch (#4): how many messages of the group carry this imageSet ID, and how many
   *  of those are settled, by their webhook_events row `file:<LINE message ID>`: event type
   *  file_saved, or file_save_failed / file_save_failed:<reason> (files/save.ts, #99). */
  countImageSet(groupId: string, imageSetId: string): Promise<ImageSetCount>
  /** INSERT INTO image_set_cards ... ON CONFLICT DO NOTHING: claimed true for the one caller
   *  that inserted the row, so one batch gets one "saved N photos" card. */
  claimImageSetCard(groupId: string, imageSetId: string): Promise<{ claimed: boolean }>
  /** #4 Dashboard: the newest `limit` files of each group, newest first, with the sender's LINE name. */
  listDashboardFiles(groupIds: string[], limit: number): Promise<DashboardFileRow[]>
  // #15 Summary
  listRecentTextMessages(groupId: string, limit: number): Promise<StoredMessage[]>  // newest `limit`, returned oldest first
  listLiveMembers(groupId: string): Promise<Member[]>                               // left_at is null
  createSummary(s: NewSummary, candidates: NewCandidate[]): Promise<{ summaryId: string; candidateIds: string[] }>
  /** #108: where the group's latest Summary ended (summaries.last_message_at of the newest
   *  row by created_at); null when the group has none. */
  getLatestSummaryEnd(groupId: string): Promise<Date | null>
  /** #108: the group's live Tasks a Summary must not propose again: every open one, and the
   *  Done ones with done_at or last_activity_at at or after `doneSince`. Newest first, at
   *  most `limit`. */
  listTasksForSummary(groupId: string, doneSince: Date, limit: number): Promise<TaskRow[]>
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
  /** groups where project_id is not null, left_at is null, owner_left_at is null (#30: the
   *  weekly insight pauses while the group has no Owner), feature_weekly_summary and
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
  // #32 daily member check: the same claim, finish and release as the daily reminder.
  /** groups where left_at is null (set up or not, as the memberLeft webhook). Every page, by id. */
  listMemberCheckGroups(): Promise<MemberCheckGroup[]>
  /** One statement: sets member_check_claimed_at = at where member_check_on is null or before
   *  todayBkk and no claim younger than `staleBefore` holds the group. */
  claimMemberCheck(groupId: string, todayBkk: string, at: Date, staleBefore: Date): Promise<{ claimed: boolean }>
  /** Marks the day checked (member_check_on = todayBkk) and clears the claim, only while the
   *  claim made `at` still holds the group. */
  finishMemberCheck(groupId: string, todayBkk: string, at: Date): Promise<void>
  /** Clears the claim made `at` without completing the day, so the next tick goes on. */
  releaseMemberCheck(groupId: string, at: Date): Promise<void>
  /** The group's live Members not yet checked on todayBkk (group_members.member_checked_on
   *  null or earlier), by line_user_id, so a tick that ran short resumes where it stopped. */
  listMembersToCheck(groupId: string, todayBkk: string): Promise<string[]>
  /** Sets member_checked_on = todayBkk on the person's membership row. */
  markMemberChecked(groupId: string, lineUserId: string, todayBkk: string): Promise<void>
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
  // #23 "ไม่ใช่งาน" and its undo. Same rule: one UPDATE, precondition in WHERE.
  /** Soft delete: deleted_at = at, deleted_by = by; only a live Task not Done that has no assignee. */
  deleteTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }>
  /** Undo of deleteTask: clears deleted_at and deleted_by; only a Task a person deleted (deleted_by set). */
  restoreTask(t: { taskId: string; by: string; at: Date }): Promise<{ updated: boolean }>
  // #29 member leaves. One UPDATE each, conditions in WHERE, so a repeat changes nothing.
  /** Sets left_at on a live membership row, or adds a left row when there is none (so a late
   *  message cannot add the person back); updated false = already left. */
  markMemberLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }>
  /** The person's live, not-Done Tasks in the group go back to Not Assigned (assignee null,
   *  status not_assigned); returns those Tasks, in no set order. Done Tasks keep the name. */
  // #29: releases the person's open Tasks in the group only while they are not a live Member, in
  // one database step (release_tasks_if_left); [] for a live Member
  releaseTasksIfLeft(t: { groupId: string; lineUserId: string }): Promise<TaskRow[]>
  /** A person joined (or rejoined) the group: adds a live row (source member_join), or clears
   *  left_at when it is earlier than `at`, so an older join arriving after a leave cannot undo it. */
  markMemberJoined(t: { groupId: string; lineUserId: string; at: Date }): Promise<void>
  // #29: a live Member's own nicknames and role (the "my info" screen); updated false when they are not live
  setMemberProfile(t: { groupId: string; lineUserId: string; nicknames: string[]; role: string | null }): Promise<{ updated: boolean }>
  // #7 Track progress
  listOpenTasks(groupId: string): Promise<TaskRow[]>                                  // live (deleted_at null), status <> done, oldest first
  getMessageRef(messageId: string): Promise<MessageRef | null>
  /** "ไม่ใช่การอัปเดตงาน": closes the message's picker. Only while not yet dismissed (first wins). */
  dismissProgressPicker(messageId: string, byLineUserId: string, at: Date): Promise<{ updated: boolean }>
  findOpenProgressPrompt(taskId: string): Promise<ProgressPromptRow | null>           // kind mark_done, answer null
  /** Insert a mark_done card. prompt null when the Task already has an open one
   *  (unique index task_prompts_one_open_mark_done). */
  createProgressPrompt(p: NewProgressPrompt): Promise<{ prompt: ProgressPromptRow | null }>
  /** #87: the cards and picks from one chat message that were answered Yes, oldest first. */
  listYesProgressPrompts(messageId: string): Promise<ProgressPromptRow[]>
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
  /** #28: saves Settings while `ownerLineUserId` is still the group's confirmed Owner (saved
   *  false otherwise, and nothing is written). Group values first, then the listed live
   *  Members' nicknames and role (the caller lists only changed ones); not one transaction,
   *  and repeating it is harmless. */
  saveGroupSettings(w: GroupSettingsWrite): Promise<{ saved: boolean }>
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
  // #30 the Owner leaves
  /** The leaver was the group's confirmed Owner: one UPDATE sets owner_left_at = at where the
   *  nominee is `lineUserId` and owner_confirmed_at is set (groups_owner_rules then clears
   *  owner_confirmed_at). updated false = they were not the confirmed Owner (any more). */
  markOwnerLeft(t: { groupId: string; lineUserId: string; at: Date }): Promise<{ updated: boolean }>
  /** Inserts the group's owner_needed card (task_prompts). promptId null when the group already
   *  has an open one (unique index task_prompts_one_open_owner_needed). */
  openOwnerNeededPrompt(p: { groupId: string; subjectLineUserId: string | null; askedAt: Date }): Promise<{ promptId: string | null }>
  /** #30 reconcile (#74): groups the bot is in whose confirmed Owner's membership is marked
   *  left at or after the confirm, with the leave time. A leave whose Owner mark failed after
   *  the membership write. */
  listConfirmedOwnersWhoLeft(): Promise<{ groupId: string; lineGroupId: string; lineUserId: string; leftAt: Date }[]>
  /** #30 reconcile (#74): groups the bot is in that are paused by an Owner leave
   *  (owner_left_at set, no confirmed Owner), with their open owner_needed card: null when
   *  none is open; `pushed` when an owner_needed push_log row for the group exists since the
   *  card was opened. ownerLineUserId is the nominee column (null after a detach). */
  listPausedOwnerCards(): Promise<PausedOwnerCard[]>
  /** The presser becomes the nominee of a main group whose Owner left, or of a group with no
   *  Project whose Owner left (a Sub group detached by #30 part B), unless another live
   *  Member already holds the nomination. Compare-and-set on the nominee read first, so of two
   *  presses at once one wins. The caller has checked that `lineUserId` is a live Member. */
  claimOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: OwnerClaimOutcome }>
  /** One transaction (rpc complete_owner_change): when `lineUserId` is the pending nominee, a
   *  live Member and has a valid latest Google account, runs change_project_owner (new Project
   *  owner, main group confirmed, owner_left_at cleared, folder IDs cleared, the active Drive
   *  connection retired, the Sub group take-over question started) and answers the open
   *  owner_needed card. Repeating it changes nothing. */
  completeOwnerChange(groupId: string, lineUserId: string, at: Date): Promise<{ outcome: CompleteOwnerChangeOutcome }>
  /** IDs of the main groups, and of the groups with no Project (#30 part B), the bot is still
   *  in, whose Owner left and that name `lineUserId` as the nominee, not yet confirmed.
   *  Ordered by id. */
  listPendingOwnerChanges(lineUserId: string): Promise<string[]>
  /** #30 part B: answers the group's open owner_needed card ('owner_confirmed'), for a new
   *  Owner confirmed outside complete_owner_change. Only while it is open; a repeat is harmless. */
  answerOwnerNeededPrompt(groupId: string, byLineUserId: string, at: Date): Promise<void>
  // #17 Dashboard read. The id lists are groups the caller already decided the requester may see.
  /** The requester's rows (live and left) in groups that belong to a Project and still have the bot. */
  listDashboardMemberships(lineUserId: string): Promise<DashboardMembership[]>
  /** #84: the groups this person is a live Member of while the bot is still in them, for the
   *  1:1 chat menu. isOwner: they are the group's confirmed Owner. */
  listUserGroups(lineUserId: string): Promise<UserGroup[]>
  /** Groups of these Projects that still have the bot: main group first, then by join time, then id. */
  listProjectGroups(projectIds: string[]): Promise<DashboardGroupRow[]>
  /** Live Members (left_at is null) of these groups, by LINE name. */
  listDashboardMembers(groupIds: string[]): Promise<DashboardMemberRow[]>
  /** Live Tasks of these groups, oldest first. */
  listDashboardTasks(groupIds: string[]): Promise<DashboardTaskRow[]>
  listLatestWeeklyInsights(groupIds: string[]): Promise<LatestWeeklyInsight[]> // #22: one per group that has any
  // #12 Google
  /** Conflict on google_subject: update, token_status 'valid'. Every sign-in sets
   *  connected_at = signedInAt, so a person's latest account is the one that signed in
   *  last, whatever else wrote to the rows since (#14). Answers the row's ID. */
  upsertGoogleAccount(a: NewGoogleAccount): Promise<{ id: string }>
  /** The person's latest account: connected_at DESC. signedInAt is that connected_at. */
  findGoogleAccountByLineUser(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired'; signedInAt: Date } | null>
  /** #14: one UPDATE that sets token_status 'revoked' and clears the refresh token, only
   *  while the row is still 'valid' and still holds `refreshTokenCiphertext` (the token
   *  Google refused). revoked: this call changed the row. So one caller per revocation gets
   *  true, and a sign-in that stored a new token in between is left alone. */
  markGoogleAccountRevoked(googleAccountId: string, refreshTokenCiphertext: string): Promise<{ revoked: boolean }>
  /** #82: the person's latest Google account (connected_at DESC) with its sealed refresh
   *  token, for the disconnect. null when they have none. */
  findGoogleAccountToken(lineUserId: string): Promise<{ id: string; tokenStatus: 'valid' | 'revoked' | 'expired'; refreshTokenCiphertext: string | null } | null>
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
  /** #14, daily access check: IDs of the Projects that have an active drive_connections
   *  row, every page, by connection id. */
  listDriveConnectedProjects(): Promise<string[]>
  /** #14, change of account: when the Project's active drive_connections row belongs to
   *  another Google account than `keepGoogleAccountId`, clears the folder IDs
   *  (projects.drive_project_folder_id, and groups.drive_folder_id of every group of the
   *  Project), then marks that row 'replaced' with status_changed_at = `at`, the same way
   *  change_project_owner retires a connection. The row is never deleted or re-pointed, so
   *  it stays as history for the files saved through it. No active row, or one of
   *  `keepGoogleAccountId`: writes nothing. retired: this call retired the row.
   *  Separate statements, cleared first and retired last: a call that stopped part-way
   *  leaves the row active, so the same call again finishes it. The clears match only the
   *  folder IDs read before the active row was read, and the row is retired only if it is
   *  still that active row after the clears, so a call that overlaps a finished change
   *  cannot erase the folder IDs the new account stored. */
  retireDriveConnection(projectId: string, keepGoogleAccountId: string, at: Date): Promise<{ retired: boolean }>
  /** The tick finisher's Projects, by id: Drive setups that have not finished. A Project is
   *  listed when its main group has a confirmed Owner and the bot, a folder ID is still
   *  empty (the Project folder, or a group that getDriveContext lists: confirmed Owner, bot
   *  still in it), the Owner's latest Google account (connected_at) is valid and no other
   *  account holds the active drive_connections row, and the later of the Owner confirm
   *  (owner_confirmed_at) and that account's updated_at lies in [from, to]. updated_at
   *  moves on every sign-in, and also when the root folder ID is stored. */
  listUnfinishedDriveProjects(from: Date, to: Date): Promise<string[]>
  // #31 Project Owner change
  /** rpc change_project_owner (one transaction): the main group must name `newOwner` as its
   *  nominee. Makes them the Project's owner, confirms the main group, clears the Project's
   *  and main group's folder IDs, retires the active Drive connection ('replaced') and puts
   *  on the take-over question (takeover_asked_at = now(), Owner confirm and folder ID
   *  cleared) every Sub group that is still waiting, or does not run on `newOwner` already
   *  (20261116010000, D1). A Sub group already confirmed on `newOwner` keeps running.
   *  Production reaches it only through complete_owner_change (completeOwnerChange). */
  changeProjectOwner(projectId: string, newOwnerLineUserId: string): Promise<{ outcome: OwnerChangeOutcome }>
  /** null when the Project does not exist. */
  getOwnerChange(projectId: string): Promise<OwnerChangeState | null>
  /** rpc answer_subgroup_takeover: the listed waiting Sub groups name the Project's owner and
   *  are confirmed (folder ID cleared); every other waiting Sub group of the Project detaches
   *  (project_id, takeover_asked_at and the folder ID null; it keeps its old nominee). */
  answerSubgroupTakeover(projectId: string, takeoverGroupIds: string[]): Promise<{ outcome: TakeoverAnswerOutcome }>
  /** Daily rule: one UPDATE that detaches every Sub group whose question was asked before
   *  `askedBefore` (groups_takeover_expiry_idx), returning those groups.
   *  #30 part B: in the same UPDATE, a waiting Sub group (no confirmed Owner) starts a fresh
   *  Owner count (owner_left_at = at) with the nominee cleared, as startDetachedOwnerCount
   *  does. owner_left_at never moves back: a group whose owner_left_at is newer than `at`
   *  is left attached, and detaches on a later tick. */
  detachExpiredTakeovers(askedBefore: Date, at: Date): Promise<DetachedSubGroup[]>
  /** #30 part B, run before a detach: one UPDATE, on those of `groupIds` with no confirmed
   *  Owner whose owner_left_at is null or older than `at`, sets owner_left_at = at (a fresh
   *  7-day Owner count) and clears the nominee (nominated_owner_line_user_id,
   *  owner_nominated_by_line_user_id, owner_nominated_at), so any live Member can claim the
   *  role (decided 2026-11-15, option B). Returns the IDs it changed; a repeat with the same
   *  `at` changes nothing, so a claim made since is kept. */
  startDetachedOwnerCount(groupIds: string[], at: Date): Promise<string[]>
  /** #31 lost take-over card: Projects whose Sub groups wait on a question asked at or after
   *  `askedAfter` (not expired), and whose main group has no owner_takeover push_log row
   *  since that ask (a push LINE refused, or one skipped near the quota, left none). */
  listUnsentTakeoverCards(askedAfter: Date): Promise<{ projectId: string; askedAt: Date }[]>
  // #11 Removal and recovery. groups.left_at / delete_after mark a group the bot left;
  // groups.joined_at is the time of the latest join event applied (null until the row's
  // first join, not the insert time), so a stale leave is ignored.
  /** The bot left the group (LINE accepted its leave call, or a leave event at `at`). One
   *  UPDATE by line_group_id: left_at = at and delete_after = at + 7 days, only where
   *  left_at is null (an existing mark never moves) and joined_at is null or <= at (a leave older
   *  than the latest re-invite changes nothing). Answers the delete_after the group holds
   *  afterwards; null when no group has this ID or the bot is in it after a newer join. */
  markBotLeft(m: { lineGroupId: string; at: Date }): Promise<{ deleteAfter: Date | null }>
  /** groups.delete_after of a group the bot left; null while the bot is in it or no such group. */
  getGroupDeleteAfter(groupId: string): Promise<Date | null>
  /** The bot joined the group at `at` (a join event). Separate idempotent UPDATEs: first,
   *  with no confirmed Owner and an owner_left_at older than `at`, owner_left_at = at (the
   *  7-day Owner count starts again, #30); then joined_at = at where it is null or older; then
   *  left_at and delete_after are cleared where left_at <= at (a re-invite inside the 7
   *  days). The Owner reset runs first, so a redelivery after a half-failure redoes all. */
  markBotJoined(j: { groupId: string; at: Date }): Promise<void>
  /** #30 part B: the groups the bot is still in (left_at null) with no confirmed Owner and
   *  owner_left_at <= `leftBefore` (groups_owner_left_idx), oldest owner_left_at first, then
   *  id, at most `limit`. */
  listOwnerlessGroups(leftBefore: Date, limit: number): Promise<OwnerlessGroup[]>
  /** #30 part B: one UPDATE detaches a Sub group that has had no Owner since before
   *  `leftBefore`: project_id and takeover_asked_at null (as detachExpiredTakeovers, #31),
   *  drive_folder_id null (its folder is in the old Owner's Drive), owner_left_at = `at`
   *  (a fresh 7-day count as a group with no Project) and the nominee cleared (option B). The WHERE holds every condition (still
   *  attached, not main, no confirmed Owner, owner_left_at <= leftBefore, bot in), so a group
   *  already detached is never detached again. detached: this call changed the row. */
  detachOwnerlessSubGroup(groupId: string, leftBefore: Date, at: Date): Promise<{ detached: boolean }>
  /** #30 part B: the group's Owner and bot state now; null when no group has this ID. */
  getOwnerExitState(groupId: string): Promise<OwnerExitState | null>
  /** IDs of the groups whose delete_after <= now, oldest delete date first, at most `limit`. */
  listPurgeDueGroups(now: Date, limit: number): Promise<string[]>
  /** One DELETE: the group row where id = groupId and delete_after <= now. Its messages,
   *  Summaries, Tasks, file records, Members and insights go with it (on delete cascade);
   *  usage keeps its rows with group_id null; push counts and webhook event IDs have no
   *  link and stay. A group re-invited since it was listed is no longer due and stays.
   *  Never touches Drive. purged: this call deleted the row. */
  purgeGroup(groupId: string, now: Date): Promise<{ purged: boolean }>
}

// ---- Composition ----
export type HandlerConfig = { lineChannelSecret: string; liffId: string; tokenEncryptionKey: Buffer; tickSecret: string }
export type Deps = {
  line: LinePort; llm: LlmPort; google: GooglePort; store: StorePort
  now: () => Date; config: HandlerConfig
  /** Waits `ms` (#4: the quiet wait of a photo batch without a total). Absent = setTimeout.
   *  The test harness moves its clock instead. */
  sleep?: (ms: number) => Promise<void>
}
export type Defer = (job: () => Promise<void>) => void
export type ApiResult = { status: number; body: unknown }

/** #99: a photo batch's count. failedReasons: one per failed photo, from its settled row's
 *  event type; a row written before #99 (no reason) reads as 'failed'. */
export type ImageSetCount = { messages: number; saved: number; failed: number; failedReasons: string[] }

/** The reason in a failed settled row's event type (`file_save_failed:<reason>`), or null when
 *  the row is not a failure. */
export function failedReasonOf(eventType: string): string | null {
  if (eventType === 'file_save_failed') return 'failed'
  return eventType.startsWith('file_save_failed:') ? eventType.slice('file_save_failed:'.length) : null
}
