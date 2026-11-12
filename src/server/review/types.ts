import type { CandidateState } from '../ports'

// Shapes of /api/review/load and /api/review/submit. Types only: the LIFF client
// imports this file with `import type`.

export type ReviewView = {
  summaryId: string; summaryText: string
  candidates: {
    id: string; state: CandidateState; title: string; details: string | null
    suggestedAssigneeLineUserId: string | null; suggestedDueAt: string | null   // ISO
  }[]
  members: { lineUserId: string; displayName: string }[]                         // LINE names
}

export type Decision =
  | { candidateId: string; action: 'confirm'; title: string; details: string | null; assigneeLineUserId: string | null; dueAt: string | null }
  | { candidateId: string; action: 'decline' }

export type SubmitResult = {
  results: { candidateId: string; outcome: 'created' | 'declined' | 'already_decided'; taskId?: string }[]
  /** The "Tasks created" message for this requester's Tasks from this Summary that the
   *  group has not been told about yet; null when there are none. */
  feedback: { text: string; taskIds: string[] } | null
  /** true when the lookup for that message failed: the page offers a retry that asks
   *  the server to announce the saved Tasks (their IDs are in `results`). */
  feedbackFailed: boolean
}

export type NotifyResult =
  | { posted: true }
  | { posted: false; reason: 'already_announced' | 'nothing_to_announce' | 'quota' | 'released' }
  | { claimed: true; text: string; taskIds: string[] }   // mode 'claim': post exactly this
