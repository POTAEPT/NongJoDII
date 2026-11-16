import type { SetupFeatures } from '../setup/types'

// Shapes of /api/settings/load and /api/settings/submit (#28). Types only: the LIFF client
// imports this file with `import type`.

/** not_set_up: the group has no confirmed Owner yet, so its values live in the setup form. */
export type SettingsState = 'ready' | 'not_set_up'

export type SettingsValues = {
  workDescription: string
  features: SetupFeatures
  dailyReminderTime: string        // 'HH:MM' Bangkok, quarter hour
  weeklySummaryWeekday: number     // ISO 1..7
  weeklySummaryTime: string        // 'HH:MM' Bangkok, quarter hour
  tagSet: string[]                 // #110
}

/** Every live Member's nicknames and role, for everyone (#81). The Owner edits every row; a
 *  Member edits only their own (through /api/me/save). Settings and the setup form are the
 *  only screens that show nicknames: pickers, cards and the Dashboard show LINE names. */
export type SettingsMember = { lineUserId: string; displayName: string; nicknames: string[]; role: string | null }

export type SettingsLoad = {
  groupId: string
  groupName: string | null
  state: SettingsState
  /** The requester is the group's confirmed Owner, so the values can be edited. */
  canEdit: boolean
  /** The person who opened Settings (from the verified ID token), so the page knows their own row (#81). */
  requesterLineUserId: string
  owner: { lineUserId: string; displayName: string } | null
  /** #80: the setup form named an Owner who has not confirmed yet (and no Owner left), so
   *  Settings waits for them. `isRequester`: the person opening Settings is that nominee. */
  pendingOwner: { lineUserId: string; displayName: string; isRequester: boolean } | null
  values: SettingsValues
  members: SettingsMember[]
}

/** #147: what the Owner types to delete the group's data at once, with Stop using. */
export const DELETE_NOW_PHRASE = 'ลบข้อมูล'

/** POST /api/settings/stop-using answer. `deleted`: the data is already gone (#147). */
export type StopUsingResult = { left: true; deleted: boolean; deleteAfter: string | null }
