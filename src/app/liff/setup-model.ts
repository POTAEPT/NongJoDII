import {
  cleanNicknames, isIsoWeekday, isQuarterHour, NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX, ROLE_MAX,
  WORK_DESCRIPTION_MAX,
} from '@/server/setup/rules'
import type { SetupFeatures, SetupLoad, SetupSubmitBody } from '@/server/setup/types'

// Pure logic of the setup form (#52, Figma v4 #2b-#2d2): defaults, step checks, the body
// the form sends and where a refused field lives. The server checks everything again
// (server/setup/submit.ts).

export const SETUP_STEPS = 4

const MSG = {
  workDescription: `เล่าได้ไม่เกิน ${WORK_DESCRIPTION_MAX} ตัวอักษร`,
  ownerMissing: 'กรุณาเลือกเจ้าของบอท 1 คน',
  ownerGone: 'คนที่เลือกเป็นเจ้าของบอทไม่ได้อยู่ในกลุ่มแล้ว กรุณาเลือกคนอื่น',
  nickname: `ชื่อเล่นยาวได้ไม่เกิน ${NICKNAME_MAX} ตัวอักษร`,
  role: `หน้าที่ยาวได้ไม่เกิน ${ROLE_MAX} ตัวอักษร`,
  members: 'ชื่อเล่นหรือหน้าที่ไม่ถูกต้อง กรุณาตรวจอีกครั้ง',
  features: 'กรุณาตรวจตัวเลือกอีกครั้ง',
  time: 'กรุณาเลือกเวลาทีละ 15 นาที',
  weekday: 'กรุณาเลือกวัน',
} as const

export type MemberForm = {
  lineUserId: string
  displayName: string   // LINE name, read only
  nicknames: string[]   // one input each; empty ones are dropped on send
  role: string
}

export type SetupForm = {
  workDescription: string
  features: SetupFeatures
  dailyReminderTime: string
  weeklySummaryWeekday: number
  weeklySummaryTime: string
  members: MemberForm[]
  ownerLineUserId: string
}

/** The loaded values (schema defaults on a new group). The Owner defaults to the current
 *  nominee while they are still listed, otherwise to the person filling in the form. */
export function initialSetupForm(view: SetupLoad): SetupForm {
  const listed = (id: string | null) => id !== null && view.members.some((m) => m.lineUserId === id)
  return {
    workDescription: view.values.workDescription,
    features: { ...view.values.features },
    dailyReminderTime: view.values.dailyReminderTime,
    weeklySummaryWeekday: view.values.weeklySummaryWeekday,
    weeklySummaryTime: view.values.weeklySummaryTime,
    members: view.members.map((m) => ({
      lineUserId: m.lineUserId, displayName: m.displayName, nicknames: [...m.nicknames], role: m.role ?? '',
    })),
    ownerLineUserId: listed(view.values.ownerLineUserId) ? (view.values.ownerLineUserId as string) : view.requesterLineUserId,
  }
}

function updateMember(form: SetupForm, lineUserId: string, fn: (m: MemberForm) => MemberForm): SetupForm {
  return { ...form, members: form.members.map((m) => (m.lineUserId === lineUserId ? fn(m) : m)) }
}

/** "+ ชื่อเล่น": one more empty input, up to the limit. */
export function addNickname(form: SetupForm, lineUserId: string): SetupForm {
  return updateMember(form, lineUserId, (m) =>
    m.nicknames.length >= NICKNAMES_PER_MEMBER_MAX ? m : { ...m, nicknames: [...m.nicknames, ''] })
}

export function setNickname(form: SetupForm, lineUserId: string, index: number, value: string): SetupForm {
  return updateMember(form, lineUserId, (m) => ({ ...m, nicknames: m.nicknames.map((n, i) => (i === index ? value : n)) }))
}

export function removeNickname(form: SetupForm, lineUserId: string, index: number): SetupForm {
  return updateMember(form, lineUserId, (m) => ({ ...m, nicknames: m.nicknames.filter((_, i) => i !== index) }))
}

export function setRole(form: SetupForm, lineUserId: string, role: string): SetupForm {
  return updateMember(form, lineUserId, (m) => ({ ...m, role }))
}

/** Thai message for the first problem on step `step` (1..4), or null when it may move on. */
export function validateStep(form: SetupForm, step: number): string | null {
  if (step === 1 && form.workDescription.trim().length > WORK_DESCRIPTION_MAX) return MSG.workDescription
  if (step === 2) {
    if (!form.members.some((m) => m.lineUserId === form.ownerLineUserId)) return MSG.ownerMissing
    for (const m of form.members) {
      if (cleanNicknames(m.nicknames).some((n) => n.length > NICKNAME_MAX)) return MSG.nickname
      if (m.role.trim().length > ROLE_MAX) return MSG.role
    }
  }
  if (step === 4) {
    if (!isQuarterHour(form.dailyReminderTime) || !isQuarterHour(form.weeklySummaryTime)) return MSG.time
    if (!isIsoWeekday(form.weeklySummaryWeekday)) return MSG.weekday
  }
  return null
}

/** Where a 400 from /api/setup/submit points: the step that owns its `field` and a short
 *  Thai message. null for any other field; the page then shows its general message. */
export function stepForField(field: unknown): { step: number; message: string } | null {
  switch (field) {
    case 'workDescription': return { step: 1, message: MSG.workDescription }
    case 'members': return { step: 2, message: MSG.members }
    case 'ownerLineUserId': return { step: 2, message: MSG.ownerGone }
    case 'features': return { step: 3, message: MSG.features }
    case 'dailyReminderTime':
    case 'weeklySummaryTime': return { step: 4, message: MSG.time }
    case 'weeklySummaryWeekday': return { step: 4, message: MSG.weekday }
    default: return null
  }
}

/** The first step with a problem and its message, checked before the final send. */
export function validateAll(form: SetupForm): { step: number; message: string } | null {
  for (let step = 1; step <= SETUP_STEPS; step++) {
    const message = validateStep(form, step)
    if (message) return { step, message }
  }
  return null
}

/** The body of /api/setup/submit without the ID token and group ID. */
export function toSubmitBody(form: SetupForm): Omit<SetupSubmitBody, 'idToken' | 'groupId'> {
  return {
    workDescription: form.workDescription.trim(),
    features: { ...form.features },
    dailyReminderTime: form.dailyReminderTime,
    weeklySummaryWeekday: form.weeklySummaryWeekday,
    weeklySummaryTime: form.weeklySummaryTime,
    members: form.members.map((m) => ({ lineUserId: m.lineUserId, nicknames: cleanNicknames(m.nicknames), role: m.role.trim() })),
    ownerLineUserId: form.ownerLineUserId,
  }
}
