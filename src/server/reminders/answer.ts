import { loginCard } from '../line/login-card'
import { bubble, button, caption, column, header, keyValue, panel, postback } from '../line/flex-ui'
import type { LineDatePickerAction, LineMessage } from '../line/types'
import { log } from '../log'
import { releaseIfLeft } from '../members/recheck'
import type { Deps, TaskRow } from '../ports'
import { resultCard } from '../progress/card'
import { deletedCard, discardConfirmCard, restoredCard, TASK_ACTION_TEXT } from '../tasks/card'
import { bangkokParts, bangkokTodayLabel, BKK_OFFSET_MS, formatThaiWeekdayDay } from '../time/bangkok'
import { ISO_DATE, type ReminderAction, encodeReminderAction, parseReminderAction, PICK_CANCEL_DATA } from './postback'

// #45 (8c) Answers to the daily reminder buttons. Rules from #8, #45 and the owner decisions:
//   - Only a person's press changes a Task (rules: Tasks and AI).
//   - Done and Postpone belong to the Task's owner: the #39 rule (assignee, or the person who
//     wrote the progress line); a reminder has no progress line, so the assignee alone.
//   - A Task with no owner shows "ฉันรับเอง" instead (option ก); any Member who has not left
//     the group may take it.
//   - A press without the presser's userId opens LIFF so LINE login identifies them.
//   - Every answer is a reply (free), never a push.

const DAY_MS = 86_400_000
/** Task buttons in the typed-fallback picker; the rest are answered from the reminder card. */
export const PICK_MAX = 10
/** Time of day for a postponed Task that had no due time. */
const DEFAULT_DUE_TIME = { hh: 18, mm: 0 }
/** Postpone choices, in days from today (Figma 6A-2: +1 day, +3 days, +1 week). */
export const POSTPONE_DAYS = [1, 3, 7] as const

export const ANSWER_TEXT = {
  postponeTitle: 'เลื่อนเป็นวันไหนดี?',
  postponeQuestion: (title: string) => `เลื่อน “${title}” ไปวันไหน?`,
  postponeChoice: (days: number, label: string) =>
    days === 1 ? `พรุ่งนี้ (${label})` : days === 7 ? `สัปดาห์หน้า (${label})` : `อีก ${days} วัน (${label})`,
  pickDate: 'เลือกวันเอง',
  postponed: (title: string, when: string) => `เลื่อนกำหนด “${title}” เป็น ${when} แล้ว`,
  postponedTitle: 'เลื่อนแล้ว',
  newDue: 'ส่งใหม่',
  remindAgain: 'เดี๋ยวเตือนอีกครั้งก่อนถึงกำหนดนะ',
  notAllowed: (name: string) => `เฉพาะ ${name} ที่ตอบงานนี้ได้`,
  noOwner: 'งานนี้ยังไม่มีผู้รับ กด “ฉันรับเอง” ก่อน',
  alreadyTaken: (name: string) => `งานนี้มีผู้รับแล้ว (${name})`,
  gone: 'งานนี้เสร็จหรือถูกลบไปแล้ว น้องจดดีไม่ได้เปลี่ยนอะไร',
  pastDate: 'เลือกได้ตั้งแต่วันนี้เป็นต้นไป',
  left: 'คุณออกจากกลุ่มนี้แล้ว จึงรับงานไม่ได้',
  needsLogin: 'LINE ไม่ได้บอกน้องจดดีว่าใครกด กดปุ่มด้านล่างเพื่อยืนยันตัวตนแล้วน้องจดดีจะบันทึกคำตอบให้',
  login: 'ยืนยันตัวตน',
  noOpenTasks: 'คุณไม่มีงานที่ยังไม่เสร็จในกลุ่มนี้',
  pickDone: 'งานไหนเสร็จแล้ว?',
  pickPostpone: 'ขอเลื่อนงานไหน?',
  pickCancel: 'ยกเลิก',
  pickCancelled: 'โอเค ไม่ได้เปลี่ยนอะไร',
  moreTasks: (n: number) => `และอีก ${n} งาน ตอบได้จากปุ่มบนการ์ดเตือนประจำวัน`,
} as const

export type ReminderResult =
  | 'done' | 'asked_date' | 'postponed' | 'taken'
  | 'not_allowed' | 'no_owner' | 'already_taken' | 'gone' | 'past_date' | 'left'
  | 'picker' | 'no_open_tasks' | 'needs_login' | 'not_mine'
  | 'confirm_discard' | 'kept' | 'deleted' | 'restored' | 'not_deleted' // #23

export type ReminderOutcome = { result: ReminderResult; message: LineMessage }

const text = (t: string): LineMessage => ({ type: 'text', text: t })

/** 'พฤ. 19 พ.ย.' for a Bangkok date 'YYYY-MM-DD'. */
function dayLabel(date: string): string {
  return formatThaiWeekdayDay(new Date(`${date}T12:00:00+07:00`))
}

/** The Bangkok date `days` after `now`'s. */
function bangkokDatePlus(now: Date, days: number): string {
  return bangkokTodayLabel(new Date(now.getTime() + days * DAY_MS))
}

/** The new due instant: the chosen Bangkok date, at the Task's old time of day (18:00 if it had none). */
export function postponedDueAt(date: string, oldDue: Date | null): Date {
  const t = oldDue ? bangkokParts(oldDue) : DEFAULT_DUE_TIME
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, t.hh, t.mm) - BKK_OFFSET_MS)
}

function formatWhen(due: Date): string {
  const p = bangkokParts(due)
  return `${dayLabel(bangkokTodayLabel(due))} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

/** Figma 6A-2: +1 day, +3 days, +1 week, and a date picker. Dates count from today. */
export function postponeChoicesCard(task: TaskRow, now: Date): LineMessage {
  const today = bangkokTodayLabel(now)
  const picker: LineDatePickerAction = {
    type: 'datetimepicker', label: ANSWER_TEXT.pickDate, mode: 'date',
    data: encodeReminderAction({ kind: 'postpone_pick', taskId: task.id }),
    initial: bangkokDatePlus(now, 1), min: today,
  }
  return {
    type: 'flex',
    altText: ANSWER_TEXT.postponeQuestion(task.title),
    contents: bubble([
      header('info', ANSWER_TEXT.postponeTitle),
      caption(task.title, { size: 'sm' }),
      column(POSTPONE_DAYS.map((n) => {
        const date = bangkokDatePlus(now, n)
        return button('outline', postback(ANSWER_TEXT.postponeChoice(n, dayLabel(date)), encodeReminderAction({ kind: 'postpone_to', taskId: task.id, date })))
      })),
      button('ghost', picker),
    ]),
  }
}

/** "งานไหน…?": one button per Task, each carrying `kind` for that Task (typed fallbacks). */
function pickTaskCard(tasks: TaskRow[], kind: 'done' | 'postpone', more: number): LineMessage {
  const title = kind === 'done' ? ANSWER_TEXT.pickDone : ANSWER_TEXT.pickPostpone
  const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)
  return {
    type: 'flex', altText: title,
    contents: bubble([
      header('info', title),
      column(tasks.map((t) => button('outline', postback(clip(t.title), encodeReminderAction({ kind, taskId: t.id }))))),
      ...(more > 0 ? [caption(ANSWER_TEXT.moreTasks(more))] : []),
      // UX review 6.1: a way out, like the progress picker's "ไม่ใช่การอัปเดตงาน".
      button('ghost', postback(ANSWER_TEXT.pickCancel, PICK_CANCEL_DATA)),
    ]),
  }
}

/** One press, by a known person. The group comes from the caller (the webhook's group, or the
 *  Task's own group on the LIFF path), never from the button data. */
export async function resolveReminderAction(
  deps: Deps,
  p: { groupId: string; userId: string; action: ReminderAction; pickedDate: string | null },
): Promise<ReminderOutcome> {
  const { groupId, userId, action } = p
  if (action.kind === 'restore') return restoreAction(deps, { groupId, userId, taskId: action.taskId })
  const task = await deps.store.getTask(action.taskId)
  if (!task || task.groupId !== groupId || task.deletedAt !== null || task.status === 'done') {
    return { result: 'gone', message: text(ANSWER_TEXT.gone) }
  }
  let members = await deps.store.listLiveMembers(groupId)
  const nameOf = (id: string) => members.find((m) => m.lineUserId === id)?.displayName ?? 'สมาชิก'
  const now = deps.now()

  if (action.kind === 'discard' || action.kind === 'discard_yes' || action.kind === 'discard_no') {
    // #23 "ไม่ใช่งาน". Only a Task nobody has taken: once someone owns it, it is their work.
    if (task.assigneeLineUserId !== null) {
      return { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(task.assigneeLineUserId))) }
    }
    if (action.kind === 'discard') return { result: 'confirm_discard', message: discardConfirmCard(task) }
    if (action.kind === 'discard_no') return { result: 'kept', message: text(TASK_ACTION_TEXT.kept(task.title)) }
    if ((await registerPresser(deps, groupId, userId)) === 'left') return { result: 'left', message: text(ANSWER_TEXT.left) }
    if (!(await deps.store.deleteTask({ taskId: task.id, by: userId, at: now })).updated) {
      const fresh = await deps.store.getTask(task.id)
      return fresh?.assigneeLineUserId && fresh.deletedAt === null
        ? { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(fresh.assigneeLineUserId))) }
        : { result: 'gone', message: text(ANSWER_TEXT.gone) }
    }
    log('task_deleted', { groupId, taskId: task.id })
    return { result: 'deleted', message: deletedCard(task) }
  }

  if (action.kind === 'take') {
    const presser = await registerPresser(deps, groupId, userId)
    if (presser === 'left') return { result: 'left', message: text(ANSWER_TEXT.left) }
    if (presser === 'added') members = await deps.store.listLiveMembers(groupId)
    if (task.assigneeLineUserId !== null) {
      return { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(task.assigneeLineUserId))) }
    }
    if (!(await deps.store.takeTask({ taskId: task.id, by: userId, at: now })).updated) {
      const fresh = await deps.store.getTask(task.id)
      return fresh?.assigneeLineUserId
        ? { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(fresh.assigneeLineUserId))) }
        : { result: 'gone', message: text(ANSWER_TEXT.gone) }
    }
    // #29: the presser may have left between the membership read above and the take.
    if (await releaseIfLeft(deps, { groupId, lineUserId: userId, event: 'reminder_take_taker_left', taskId: task.id })) {
      return { result: 'left', message: text(ANSWER_TEXT.left) }
    }
    log('reminder_taken', { groupId, taskId: task.id })
    return {
      result: 'taken',
      message: resultCard({ task, status: 'in_process', confirmedByName: nameOf(userId), assigneeName: nameOf(userId), at: now }),
    }
  }

  // Done and Postpone: the owner only.
  /** The write found the Task changed since it was read: reassigned to someone else, or gone. */
  const lostWrite = async (): Promise<ReminderOutcome> => {
    const fresh = await deps.store.getTask(task.id)
    const open = fresh && fresh.deletedAt === null && fresh.status !== 'done'
    if (!open) return { result: 'gone', message: text(ANSWER_TEXT.gone) }
    if (fresh.assigneeLineUserId === null) return { result: 'no_owner', message: text(ANSWER_TEXT.noOwner) }
    return { result: 'not_allowed', message: text(ANSWER_TEXT.notAllowed(nameOf(fresh.assigneeLineUserId))) }
  }
  if (task.assigneeLineUserId === null) return { result: 'no_owner', message: text(ANSWER_TEXT.noOwner) }
  if (task.assigneeLineUserId !== userId) {
    return { result: 'not_allowed', message: text(ANSWER_TEXT.notAllowed(nameOf(task.assigneeLineUserId))) }
  }

  if (action.kind === 'done') {
    if (!(await deps.store.markTaskDone({ taskId: task.id, by: userId, at: now })).updated) return lostWrite()
    log('reminder_done', { groupId, taskId: task.id })
    return { result: 'done', message: resultCard({ task, status: 'done', confirmedByName: nameOf(userId), assigneeName: null, at: now }) }
  }

  if (action.kind === 'postpone') return { result: 'asked_date', message: postponeChoicesCard(task, now) }

  const date = action.kind === 'postpone_to' ? action.date : p.pickedDate
  // Without a valid date (a picker press that lost its params), ask again.
  if (!date || !ISO_DATE.test(date)) return { result: 'asked_date', message: postponeChoicesCard(task, now) }
  const dueAt = postponedDueAt(date, task.dueAt)
  // ISO_DATE checks only the shape: Date.UTC rolls '2026-11-45' over to December 15. A date
  // that does not come back as itself is not a real date, so ask again.
  if (bangkokTodayLabel(dueAt) !== date) return { result: 'asked_date', message: postponeChoicesCard(task, now) }
  if (date < bangkokTodayLabel(now)) return { result: 'past_date', message: text(ANSWER_TEXT.pastDate) }
  if (!(await deps.store.postponeTask({ taskId: task.id, dueAt, by: userId, at: now })).updated) return lostWrite()
  log('reminder_postponed', { groupId, taskId: task.id })
  return { result: 'postponed', message: postponedCard(task.title, formatWhen(dueAt)) }
}

/** 'left' = the presser left the group. A first-time presser: LINE sent the press from this
 *  group, so they are in it. Register them as a Member first, so the Task shows their name and
 *  stays editable (the edit endpoint accepts only a live Member as the assignee), and so the
 *  line_users row exists for the write. */
async function registerPresser(deps: Deps, groupId: string, userId: string): Promise<'left' | 'member' | 'added'> {
  const membership = await deps.store.getMembership(groupId, userId)
  if (membership === 'left') return 'left'
  if (membership === 'none') {
    await deps.store.touchGroupMember(groupId, userId, 'message')
    return 'added'
  }
  return 'member'
}

/** #23 "กู้คืน" on the deleted reply: any Member who has not left may undo the delete. */
async function restoreAction(
  deps: Deps, p: { groupId: string; userId: string; taskId: string },
): Promise<ReminderOutcome> {
  const task = await deps.store.getTask(p.taskId)
  if (!task || task.groupId !== p.groupId) return { result: 'gone', message: text(ANSWER_TEXT.gone) }
  if (task.deletedAt === null) return { result: 'not_deleted', message: text(TASK_ACTION_TEXT.notDeleted) }
  if ((await registerPresser(deps, p.groupId, p.userId)) === 'left') return { result: 'left', message: text(ANSWER_TEXT.left) }
  if (!(await deps.store.restoreTask({ taskId: task.id, by: p.userId, at: deps.now() })).updated) {
    const fresh = await deps.store.getTask(task.id)
    return fresh && fresh.deletedAt === null
      ? { result: 'not_deleted', message: text(TASK_ACTION_TEXT.notDeleted) }
      : { result: 'gone', message: text(ANSWER_TEXT.gone) }
  }
  log('task_restored', { groupId: p.groupId, taskId: task.id })
  return { result: 'restored', message: restoredCard(task, deps.config.liffId) }
}

/** Figma 6A-3: "เลื่อนแล้ว · ส่งใหม่: …". The altText keeps the full sentence (the LIFF
 *  login page shows it). */
function postponedCard(title: string, when: string): LineMessage {
  return {
    type: 'flex',
    altText: ANSWER_TEXT.postponed(title, when),
    contents: bubble([
      header('success', ANSWER_TEXT.postponedTitle),
      caption(title, { size: 'sm' }),
      panel([keyValue(ANSWER_TEXT.newDue, when)]),
      caption(ANSWER_TEXT.remindAgain),
    ]),
  }
}

function loginMessage(liffId: string, data: string): LineMessage {
  return loginCard(liffId, data)
}

/** A reminder button pressed in a group (webhook). 'not_mine' = another feature's button. */
export async function handleReminderPostback(
  deps: Deps,
  job: { groupId: string; userId: string | null; data: string; pickedDate: string | null; replyToken: string },
): Promise<ReminderResult> {
  const action = parseReminderAction(job.data)
  if (!action) return 'not_mine'
  if (!job.userId) {
    // The LIFF page repeats the press after LINE login. A picked date cannot ride along, so a
    // date-picker press goes back to the choices.
    const data = action.kind === 'postpone_pick' ? encodeReminderAction({ kind: 'postpone', taskId: action.taskId }) : job.data
    await deps.line.reply(job.replyToken, [loginMessage(deps.config.liffId, data)])
    log('reminder_needs_login', { groupId: job.groupId })
    return 'needs_login'
  }
  const outcome = await resolveReminderAction(deps, { groupId: job.groupId, userId: job.userId, action, pickedDate: job.pickedDate })
  await deps.line.reply(job.replyToken, [outcome.message])
  return outcome.result
}

/** Typed fallbacks "NongJoDII done" / "NongJoDII need time" (#8): act on the sender's own open
 *  Tasks in the group. One Task: as if its button was pressed. Several: ask which. */
export async function handleReminderCommand(
  deps: Deps,
  p: { groupId: string; userId: string; command: 'done' | 'need_time'; replyToken: string },
): Promise<ReminderResult> {
  // Nearest due date first (no due date last), so the picker's first buttons are the most urgent.
  const mine = (await deps.store.listOpenTasks(p.groupId))
    .filter((t) => t.assigneeLineUserId === p.userId)
    .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
  const kind = p.command === 'done' ? 'done' : 'postpone'
  let outcome: ReminderOutcome
  if (mine.length === 0) {
    outcome = { result: 'no_open_tasks', message: text(ANSWER_TEXT.noOpenTasks) }
  } else if (mine.length === 1) {
    outcome = await resolveReminderAction(deps, {
      groupId: p.groupId, userId: p.userId, action: { kind, taskId: mine[0].id }, pickedDate: null,
    })
  } else {
    outcome = { result: 'picker', message: pickTaskCard(mine.slice(0, PICK_MAX), kind, mine.length - PICK_MAX) }
  }
  await deps.line.reply(p.replyToken, [outcome.message])
  return outcome.result
}
