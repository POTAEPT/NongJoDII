import type { GroupPushResult } from '../line/push-budget'

// Shapes of /api/setup/load, /api/setup/submit and /api/setup/confirm-owner. Types only:
// the LIFF client imports this file with `import type`.

/** open: nobody named as Owner yet. pending_owner: named, not confirmed (the form can
 *  still be sent again). confirmed: the Owner confirmed. in_project: the group already
 *  belongs to a Project without a confirmed Owner (an Owner change, not setup). The form
 *  takes changes only while open or pending_owner; later edits belong to Settings (#28). */
export type SetupState = 'open' | 'pending_owner' | 'confirmed' | 'in_project'

/** The four checkboxes of #2d. `summarize` covers Summaries and Task drafts together. */
export type SetupFeatures = { summarize: boolean; saveFiles: boolean; trackRemind: boolean; weeklySummary: boolean }

export type SetupValues = {
  workDescription: string
  features: SetupFeatures
  dailyReminderTime: string        // 'HH:MM' Bangkok, quarter hour
  weeklySummaryWeekday: number     // ISO 1..7
  weeklySummaryTime: string        // 'HH:MM' Bangkok, quarter hour
  ownerLineUserId: string | null   // the current nominee
}

export type SetupMember = { lineUserId: string; displayName: string; nicknames: string[]; role: string | null }

export type SetupLoad = {
  groupId: string
  groupName: string | null
  state: SetupState
  /** The verified requester, derived from the ID token: the form's default Owner. The
   *  server never reads it back as identity. */
  requesterLineUserId: string
  values: SetupValues
  /** Live Members by LINE name; the requester is always one of them. */
  members: SetupMember[]
  nominee: { lineUserId: string; displayName: string } | null
}

export type SetupSubmitBody = {
  idToken: string
  groupId: string
  workDescription: string
  features: SetupFeatures
  dailyReminderTime: string
  weeklySummaryWeekday: number
  weeklySummaryTime: string
  members: { lineUserId: string; nicknames: string[]; role: string }[]
  ownerLineUserId: string
}

/** The #2e card's push result: skipped or failed still means the setup is saved, and a
 *  resend with the same nominee pushes the same card again under the same retry key. */
export type SetupSubmitResult = { state: 'confirmed' | 'pending_owner'; posted: GroupPushResult }
/** POST /api/setup/resend-card: the card pushed again for the saved nomination; ownerName
 *  is the nominee the group holds now, which may differ from the page's form. */
export type SetupResendResult = { state: 'pending_owner'; posted: GroupPushResult; ownerName: string }

export type OwnerConfirmResult = { state: 'confirmed'; alreadyConfirmed: boolean }
