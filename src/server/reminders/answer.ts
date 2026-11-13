import { liffUrl } from '../liff-links'
import type { LineDatePickerAction, LineMessage, LinePostbackAction } from '../line/types'
import { log } from '../log'
import type { Deps, TaskRow } from '../ports'
import { resultCard } from '../progress/card'
import { BKK_OFFSET_MS, bangkokIsoWeekday, bangkokParts, bangkokTodayLabel, formatThaiDayMonth } from '../time/bangkok'
import { ISO_DATE, type ReminderAction, encodeReminderAction, parseReminderAction } from './postback'

// #45 (8c) Answers to the daily reminder buttons. Rules from #8, #45 and the owner decisions:
//   - Only a person's press changes a Task (rules: Tasks and AI).
//   - Done and Postpone belong to the Task's owner: the #39 rule (assignee, or the person who
//     wrote the progress line); a reminder has no progress line, so the assignee alone.
//   - A Task with no owner shows "ฉันรับเอง" instead (option ก); any Member who has not left
//     the group may take it.
//   - A press without the presser's userId opens LIFF so LINE login identifies them.
//   - Every answer is a reply (free), never a push.

const DAY_MS = 86_400_000
/** Time of day for a postponed Task that had no due time. */
const DEFAULT_DUE_TIME = { hh: 18, mm: 0 }
const THAI_WEEKDAY_SHORT = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'] // ISO 1..7
/** Postpone choices, in days from today (Figma 6A-2: +1 day, +3 days, +1 week). */
export const POSTPONE_DAYS = [1, 3, 7] as const

export const ANSWER_TEXT = {
  postponeQuestion: (title: string) => `เลื่อน “${title}” ไปวันไหน?`,
  postponeChoice: (days: number, label: string) => (days === 7 ? `+1 สัปดาห์ (${label})` : `+${days} วัน (${label})`),
  pickDate: 'เลือกวันเอง',
  postponed: (title: string, when: string) => `เลื่อนกำหนด “${title}” เป็น ${when} แล้ว`,
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
} as const

export type ReminderResult =
  | 'done' | 'asked_date' | 'postponed' | 'taken'
  | 'not_allowed' | 'no_owner' | 'already_taken' | 'gone' | 'past_date' | 'left'
  | 'picker' | 'no_open_tasks' | 'needs_login' | 'not_mine'

export type ReminderOutcome = { result: ReminderResult; message: LineMessage }

const text = (t: string): LineMessage => ({ type: 'text', text: t })

/** 'พฤ. 19 พ.ย.' for a Bangkok date 'YYYY-MM-DD'. */
function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00+07:00`)
  return `${THAI_WEEKDAY_SHORT[bangkokIsoWeekday(d) - 1]} ${formatThaiDayMonth(d)}`
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

function postbackButton(label: string, data: string, primary: boolean) {
  const action: LinePostbackAction = { type: 'postback', label, data, displayText: label }
  return { type: 'button', style: primary ? 'primary' : 'secondary', color: primary ? '#1F5BAD' : '#DCE8F7', height: 'sm', action }
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
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          { type: 'text', text: ANSWER_TEXT.postponeQuestion(task.title), wrap: true, weight: 'bold', size: 'md', color: '#14213D' },
          ...POSTPONE_DAYS.map((n) => {
            const date = bangkokDatePlus(now, n)
            return postbackButton(ANSWER_TEXT.postponeChoice(n, dayLabel(date)), encodeReminderAction({ kind: 'postpone_to', taskId: task.id, date }), false)
          }),
          { type: 'button', style: 'link', color: '#1F5BAD', height: 'sm', action: picker },
        ],
      },
    },
  }
}

/** "งานไหน…?": one button per Task, each carrying `kind` for that Task (typed fallbacks). */
function pickTaskCard(tasks: TaskRow[], kind: 'done' | 'postpone'): LineMessage {
  const title = kind === 'done' ? ANSWER_TEXT.pickDone : ANSWER_TEXT.pickPostpone
  const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 39)}…` : s)
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          { type: 'text', text: title, wrap: true, weight: 'bold', size: 'md', color: '#14213D' },
          ...tasks.map((t) => postbackButton(clip(t.title), encodeReminderAction({ kind, taskId: t.id }), false)),
        ],
      },
    },
  }
}

/** One press, by a known person. The group comes from the caller (the webhook's group, or the
 *  Task's own group on the LIFF path), never from the button data. */
export async function resolveReminderAction(
  deps: Deps,
  p: { groupId: string; userId: string; action: ReminderAction; pickedDate: string | null },
): Promise<ReminderOutcome> {
  const { groupId, userId, action } = p
  const task = await deps.store.getTask(action.taskId)
  if (!task || task.groupId !== groupId || task.deletedAt !== null || task.status === 'done') {
    return { result: 'gone', message: text(ANSWER_TEXT.gone) }
  }
  const members = await deps.store.listLiveMembers(groupId)
  const nameOf = (id: string) => members.find((m) => m.lineUserId === id)?.displayName ?? 'สมาชิก'
  const now = deps.now()

  if (action.kind === 'take') {
    if ((await deps.store.getMembership(groupId, userId)) === 'left') return { result: 'left', message: text(ANSWER_TEXT.left) }
    if (task.assigneeLineUserId !== null) {
      return { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(task.assigneeLineUserId))) }
    }
    if (!(await deps.store.takeTask({ taskId: task.id, by: userId, at: now })).updated) {
      const fresh = await deps.store.getTask(task.id)
      return fresh?.assigneeLineUserId
        ? { result: 'already_taken', message: text(ANSWER_TEXT.alreadyTaken(nameOf(fresh.assigneeLineUserId))) }
        : { result: 'gone', message: text(ANSWER_TEXT.gone) }
    }
    log('reminder_taken', { groupId, taskId: task.id })
    return {
      result: 'taken',
      message: resultCard({ task, status: 'in_process', confirmedByName: nameOf(userId), assigneeName: nameOf(userId), at: now }),
    }
  }

  // Done and Postpone: the owner only.
  if (task.assigneeLineUserId === null) return { result: 'no_owner', message: text(ANSWER_TEXT.noOwner) }
  if (task.assigneeLineUserId !== userId) {
    return { result: 'not_allowed', message: text(ANSWER_TEXT.notAllowed(nameOf(task.assigneeLineUserId))) }
  }

  if (action.kind === 'done') {
    if (!(await deps.store.markTaskDone({ taskId: task.id, by: userId, at: now })).updated) {
      return { result: 'gone', message: text(ANSWER_TEXT.gone) }
    }
    log('reminder_done', { groupId, taskId: task.id })
    return { result: 'done', message: resultCard({ task, status: 'done', confirmedByName: nameOf(userId), assigneeName: null, at: now }) }
  }

  if (action.kind === 'postpone') return { result: 'asked_date', message: postponeChoicesCard(task, now) }

  const date = action.kind === 'postpone_to' ? action.date : p.pickedDate
  // Without a valid date (a picker press that lost its params), ask again.
  if (!date || !ISO_DATE.test(date)) return { result: 'asked_date', message: postponeChoicesCard(task, now) }
  if (date < bangkokTodayLabel(now)) return { result: 'past_date', message: text(ANSWER_TEXT.pastDate) }
  const dueAt = postponedDueAt(date, task.dueAt)
  if (!(await deps.store.postponeTask({ taskId: task.id, dueAt, by: userId, at: now })).updated) {
    return { result: 'gone', message: text(ANSWER_TEXT.gone) }
  }
  log('reminder_postponed', { groupId, taskId: task.id })
  return { result: 'postponed', message: text(ANSWER_TEXT.postponed(task.title, formatWhen(dueAt))) }
}

function loginMessage(liffId: string, data: string): LineMessage {
  return {
    type: 'template', altText: ANSWER_TEXT.needsLogin,
    template: { type: 'buttons', text: ANSWER_TEXT.needsLogin, actions: [{ type: 'uri', label: ANSWER_TEXT.login, uri: liffUrl(liffId, 'progress', data) }] },
  }
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
  const mine = (await deps.store.listOpenTasks(p.groupId)).filter((t) => t.assigneeLineUserId === p.userId)
  const kind = p.command === 'done' ? 'done' : 'postpone'
  let outcome: ReminderOutcome
  if (mine.length === 0) {
    outcome = { result: 'no_open_tasks', message: text(ANSWER_TEXT.noOpenTasks) }
  } else if (mine.length === 1) {
    outcome = await resolveReminderAction(deps, {
      groupId: p.groupId, userId: p.userId, action: { kind, taskId: mine[0].id }, pickedDate: null,
    })
  } else {
    outcome = { result: 'picker', message: pickTaskCard(mine.slice(0, 10), kind) }
  }
  await deps.line.reply(p.replyToken, [outcome.message])
  return outcome.result
}
