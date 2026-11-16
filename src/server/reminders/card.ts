import { COLOR, bubble, button, buttonRow, caption, header, keyValue, panel, postback, text, title, type Tone } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { BKK_OFFSET_MS, bangkokParts, formatRelativeDue, formatThaiWeekdayDay } from '../time/bangkok'
import { encodeReminderAction } from './postback'
import type { ReminderItem, ReminderReason } from './select'

// #44 (8b) The daily reminder post: one Flex carousel per group per day. The first bubble
// sums up the day; then one bubble per Task, styled like Figma "UI v4" 6A / 6B / 6C: the
// most urgent reason as the header, the owner and due date, and the Done / Postpone
// buttons (answered in #45). Cards show LINE names, never nicknames (decided 2026-11-11).

const TITLE_MAX = 60
const DAY_MS = 86_400_000

export const REMINDER_TEXT = {
  title: 'แจ้งเตือนงานวันนี้',
  more: (n: number) => `และอีก ${n} งาน ดูได้ใน Dashboard`,
  done: 'เสร็จแล้ว',
  postpone: 'ขอเลื่อน',  // Figma UI v4, frame 6A
  take: 'ฉันรับเอง',     // Figma 6C: a Task with no owner offers this instead (#45, option ก)
  owner: 'ผู้รับ',
  due: 'กำหนดส่ง',
  noOwner: 'ยังไม่มีผู้รับ',
  noDue: 'ยังไม่กำหนด',
} as const

/** Bangkok calendar days from a to b (b later = positive). */
function bangkokDayDiff(a: Date, b: Date): number {
  const day = (d: Date) => Math.floor((d.getTime() + BKK_OFFSET_MS) / DAY_MS)
  return day(b) - day(a)
}

function hhmm(d: Date): string {
  const p = bangkokParts(d)
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

/** One short Thai line per reason, e.g. 'เลยกำหนด 2 วัน', 'ครบกำหนดวันนี้ 17:00'. */
export function reasonLabel(reason: ReminderReason, item: ReminderItem, now: Date): string {
  const { dueAt, lastActivityAt } = item.task
  switch (reason) {
    case 'overdue': {
      const days = dueAt ? bangkokDayDiff(dueAt, now) : 0
      return days >= 1 ? `เลยกำหนด ${days} วัน` : `เลยกำหนดแล้ว (${dueAt ? hhmm(dueAt) : ''})`
    }
    case 'due_today':
      return `ครบกำหนดวันนี้ ${dueAt ? hhmm(dueAt) : ''}`.trim()
    case 'due_tomorrow':
      return `ครบกำหนดพรุ่งนี้ ${dueAt ? hhmm(dueAt) : ''}`.trim()
    case 'no_assignee':
      return 'ยังไม่มีผู้รับ'
    case 'no_update': {
      const days = lastActivityAt ? Math.floor((now.getTime() - lastActivityAt.getTime()) / DAY_MS) : 0
      return `ไม่มีอัปเดต ${days} วัน`
    }
  }
}

/** Counts per reason for the summary bubble and the notification text. A Task counts once,
 *  under its most urgent reason. */
export function reasonCounts(items: ReminderItem[]): { overdue: number; dueSoon: number; noAssignee: number; noUpdate: number } {
  const c = { overdue: 0, dueSoon: 0, noAssignee: 0, noUpdate: 0 }
  for (const { reasons } of items) {
    const top = reasons[0]
    if (top === 'overdue') c.overdue++
    else if (top === 'due_today' || top === 'due_tomorrow') c.dueSoon++
    else if (top === 'no_assignee') c.noAssignee++
    else c.noUpdate++
  }
  return c
}

function clip(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

/** The card header for a Task's most urgent reason (Figma 6A ใกล้ถึงกำหนด, 6B เลยกำหนด, 6C ยังไม่มีผู้รับ). */
function reasonTone(reason: ReminderReason): Tone {
  return reason === 'overdue' ? 'warning' : 'reminder'
}

/** UX review 4.3: this card is about today, so 'วันนี้ 17:00' / 'พรุ่งนี้ 09:00', else 'พฤ. 19 พ.ย. 17:00'. */
function dueText(due: Date | null, now: Date): string {
  if (!due) return REMINDER_TEXT.noDue
  return formatRelativeDue(due, now)
}

function summaryBubble(items: ReminderItem[], total: number, now: Date) {
  const c = reasonCounts(items)
  const lines = [
    c.overdue ? `เลยกำหนด ${c.overdue} งาน` : null,
    c.dueSoon ? `ครบกำหนดวันนี้-พรุ่งนี้ ${c.dueSoon} งาน` : null,
    c.noAssignee ? `ยังไม่มีผู้รับ ${c.noAssignee} งาน` : null,
    c.noUpdate ? `ไม่มีอัปเดตเกิน 5 วัน ${c.noUpdate} งาน` : null,
  ].filter((x): x is string => x !== null)
  return bubble([
    header('reminder', REMINDER_TEXT.title),
    caption(`${formatThaiWeekdayDay(now)} · ${total} งานที่ต้องดู`),
    panel(lines.map((l) => text(`• ${l}`))),
    ...(total > items.length ? [caption(REMINDER_TEXT.more(total - items.length))] : []),
  ])
}

function taskBubble(item: ReminderItem, names: Map<string, string | null>, now: Date) {
  const { task, reasons } = item
  const top = reasons[0]
  const owner = task.assigneeLineUserId ? (names.get(task.assigneeLineUserId) ?? 'สมาชิก') : REMINDER_TEXT.noOwner
  const ownerColor = task.assigneeLineUserId ? COLOR.ink : '#92400E'
  const dueColor = top === 'overdue' ? COLOR.danger : COLOR.ink
  return bubble(
    [
      header(reasonTone(top), reasonLabel(top, item, now)),
      title(clip(task.title)),
      panel([keyValue(REMINDER_TEXT.owner, owner, ownerColor), keyValue(REMINDER_TEXT.due, dueText(task.dueAt, now), dueColor)]),
      ...reasons.slice(1).map((r) => caption(reasonLabel(r, item, now))),
    ],
    // Done and Postpone belong to the Task's owner (the #39 rule). A Task with no owner has
    // nobody who may answer them, so its next step is someone taking it.
    task.assigneeLineUserId === null
      ? [button('primary', postback(REMINDER_TEXT.take, encodeReminderAction({ kind: 'take', taskId: task.id })))]
      : [buttonRow(
          button('secondary', postback(REMINDER_TEXT.postpone, encodeReminderAction({ kind: 'postpone', taskId: task.id }))),
          button('primary', postback(REMINDER_TEXT.done, encodeReminderAction({ kind: 'done', taskId: task.id }))),
        )],
  )
}

/** The notification text, e.g. 'แจ้งเตือนงานวันนี้: เลยกำหนด 1 · ใกล้ครบกำหนด 2 · ยังไม่มีผู้รับ 1'. */
export function reminderAltText(items: ReminderItem[], total: number): string {
  const c = reasonCounts(items)
  const parts = [
    c.overdue ? `เลยกำหนด ${c.overdue}` : null,
    c.dueSoon ? `ใกล้ครบกำหนด ${c.dueSoon}` : null,
    c.noAssignee ? `ยังไม่มีผู้รับ ${c.noAssignee}` : null,
    c.noUpdate ? `ไม่มีอัปเดต ${c.noUpdate}` : null,
  ].filter((x): x is string => x !== null)
  const more = total > items.length ? ` (+${total - items.length})` : ''
  return `${REMINDER_TEXT.title}: ${parts.join(' · ')}${more}`
}

/** One Flex carousel: the summary, then one bubble per Task. `names` maps LINE user IDs to
 *  LINE names (never nicknames). Call only with at least one item: an empty day sends nothing. */
export function reminderCarousel(p: {
  items: ReminderItem[]; total: number; names: Map<string, string | null>; now: Date
}): LineMessage {
  const { items, total, names, now } = p
  if (items.length === 0) throw new Error('reminderCarousel needs at least one item')
  return {
    type: 'flex',
    altText: reminderAltText(items, total),
    contents: {
      type: 'carousel',
      contents: [summaryBubble(items, total, now), ...items.map((item) => taskBubble(item, names, now))],
    },
  }
}
