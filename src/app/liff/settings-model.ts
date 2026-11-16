import { cleanNicknames, NICKNAME_MAX, ROLE_MAX } from '@/server/setup/rules'
import type { SettingsLoad } from '@/server/settings/types'
import { type SetupForm, stepForField, validateStep } from './setup-model'

// Pure logic of Settings (#28). It edits the setup form's values, so it keeps the setup
// form's shape and helpers; the Owner is shown, not edited here (#30, #31). The server
// checks everything again (server/settings/settings.ts).

const MSG = {
  nickname: `ชื่อเล่นยาวได้ไม่เกิน ${NICKNAME_MAX} ตัวอักษร`,
  role: `หน้าที่ยาวได้ไม่เกิน ${ROLE_MAX} ตัวอักษร`,
} as const

export function initialSettingsForm(view: SettingsLoad): SetupForm {
  return {
    workDescription: view.values.workDescription,
    features: { ...view.values.features },
    dailyReminderTime: view.values.dailyReminderTime,
    weeklySummaryWeekday: view.values.weeklySummaryWeekday,
    weeklySummaryTime: view.values.weeklySummaryTime,
    members: view.members.map((m) => ({
      lineUserId: m.lineUserId, displayName: m.displayName, nicknames: [...m.nicknames], role: m.role ?? '',
    })),
    ownerLineUserId: view.owner?.lineUserId ?? '',
    tagSet: [...(view.values.tagSet ?? [])],
    attachProjectId: null, // #146: the setup form only
  }
}

/** Thai message for the first problem, or null. The setup form's checks without its Owner pick. */
export function validateSettings(form: SetupForm): string | null {
  const first = validateStep(form, 1)
  if (first) return first
  for (const m of form.members) {
    if (cleanNicknames(m.nicknames).some((n) => n.length > NICKNAME_MAX)) return MSG.nickname
    if (m.role.trim().length > ROLE_MAX) return MSG.role
  }
  return validateStep(form, 3) ?? validateStep(form, 4)
}

/** The body of /api/settings/submit without the ID token and group ID. */
export function toSettingsBody(form: SetupForm) {
  return {
    workDescription: form.workDescription.trim(),
    features: { ...form.features },
    dailyReminderTime: form.dailyReminderTime,
    weeklySummaryWeekday: form.weeklySummaryWeekday,
    weeklySummaryTime: form.weeklySummaryTime,
    members: form.members.map((m) => ({ lineUserId: m.lineUserId, nicknames: cleanNicknames(m.nicknames), role: m.role.trim() })),
    tagSet: form.tagSet,
  }
}

/** The message for a 400's `field`, or null for the page's general message. */
export function settingsFieldMessage(field: unknown): string | null {
  return stepForField(field)?.message ?? null
}

/** #81: a Member (not the Owner) edits only their own row. The same length checks as the
 *  Owner's save, for that one row; null when it is fine. */
export function validateMyRow(form: SetupForm, me: string): string | null {
  const m = form.members.find((x) => x.lineUserId === me)
  if (!m) return null
  if (cleanNicknames(m.nicknames).some((n) => n.length > NICKNAME_MAX)) return MSG.nickname
  if (m.role.trim().length > ROLE_MAX) return MSG.role
  return null
}

/** #81: the body of /api/me/save for the requester's own row (the server takes the person
 *  from the ID token, never from this body), or null when they have no row. */
export function toMyProfileBody(form: SetupForm, me: string): { nicknames: string[]; role: string } | null {
  const m = form.members.find((x) => x.lineUserId === me)
  return m ? { nicknames: cleanNicknames(m.nicknames), role: m.role.trim() } : null
}
