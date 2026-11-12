// Pure conversions from PostgREST rows (snake_case, timestamps as ISO strings)
// to the domain types of src/server/ports.ts.
import type { CandidateRow, CandidateState, GroupRow, Member, MessageMention, StoredMessage, TaskRow, TaskStatus } from '../ports'

type Ts = string
type NameEmbed = { display_name: string | null } | null

export type DbGroup = {
  id: string; line_group_id: string; project_id: string | null; name: string | null
  nominated_owner_line_user_id: string | null; owner_confirmed_at: Ts | null
  feature_summarize: boolean; feature_draft_tasks: boolean; work_description: string | null
  feature_track_remind: boolean
}
export type DbMessage = {
  id: string; sender_line_user_id: string | null; text: string; sent_at: Ts; line_users: NameEmbed
  mentions: MessageMention[] | null   // jsonb, stored in the same shape
}
export type DbMember = { line_user_id: string; nicknames: string[] | null; role: string | null; line_users: NameEmbed }
export type DbCandidate = {
  id: string; summary_id: string; state: CandidateState; title: string; details: string | null
  suggested_assignee_line_user_id: string | null; suggested_due_at: Ts | null
}
export type DbTask = {
  id: string; group_id: string; candidate_id: string | null; title: string; details: string | null
  status: TaskStatus; assignee_line_user_id: string | null; created_by_line_user_id: string
  due_at: Ts | null; deleted_at: Ts | null; groups: { line_group_id: string }
}

export function toDate(ts: Ts): Date
export function toDate(ts: Ts | null): Date | null
export function toDate(ts: Ts | null): Date | null {
  return ts === null ? null : new Date(ts)
}

export function toGroupRow(r: DbGroup): GroupRow {
  return {
    id: r.id, lineGroupId: r.line_group_id, projectId: r.project_id, name: r.name,
    nominatedOwnerLineUserId: r.nominated_owner_line_user_id, ownerConfirmedAt: toDate(r.owner_confirmed_at),
    featureSummarize: r.feature_summarize, featureDraftTasks: r.feature_draft_tasks,
    workDescription: r.work_description, featureTrackRemind: r.feature_track_remind,
  }
}

export function toStoredMessage(r: DbMessage): StoredMessage {
  return {
    id: r.id, senderLineUserId: r.sender_line_user_id, senderDisplayName: r.line_users?.display_name ?? null,
    text: r.text, sentAt: toDate(r.sent_at), mentions: r.mentions ?? null,
  }
}

export function toMember(r: DbMember): Member {
  return {
    lineUserId: r.line_user_id, displayName: r.line_users?.display_name ?? null,
    nicknames: r.nicknames ?? [], role: r.role,
  }
}

export function toCandidateRow(r: DbCandidate): CandidateRow {
  return {
    id: r.id, summaryId: r.summary_id, state: r.state, title: r.title, details: r.details,
    suggestedAssigneeLineUserId: r.suggested_assignee_line_user_id, suggestedDueAt: toDate(r.suggested_due_at),
  }
}

export function toTaskRow(r: DbTask): TaskRow {
  return {
    id: r.id, groupId: r.group_id, lineGroupId: r.groups.line_group_id, candidateId: r.candidate_id,
    title: r.title, details: r.details, status: r.status, assigneeLineUserId: r.assignee_line_user_id,
    createdByLineUserId: r.created_by_line_user_id, dueAt: toDate(r.due_at), deletedAt: toDate(r.deleted_at),
  }
}
