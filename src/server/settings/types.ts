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
}

/** Nicknames and role are filled only for the Owner, who edits them; a Member sees LINE names. */
export type SettingsMember = { lineUserId: string; displayName: string; nicknames: string[]; role: string | null }

export type SettingsLoad = {
  groupId: string
  groupName: string | null
  state: SettingsState
  /** The requester is the group's confirmed Owner, so the values can be edited. */
  canEdit: boolean
  owner: { lineUserId: string; displayName: string } | null
  values: SettingsValues
  members: SettingsMember[]
}
