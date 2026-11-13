import type { LineMessage, LinePostbackAction } from '../line/types'
import type { TaskStatus } from '../ports'
import { BKK_OFFSET_MS, bangkokParts } from '../time/bangkok'
import { encodeReminderAction } from './postback'
import type { ReminderItem, ReminderReason } from './select'

// #44 (8b) The daily reminder post: one Flex carousel per group per day. The first bubble
// sums up the day; then one bubble per Task with its reasons and the Done / Postpone
// buttons (answered in #45). Same look as the Track progress cards (progress/card.ts).
// Cards show LINE names, never nicknames (decided 2026-11-11).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD', primarySoft: '#DCE8F7', red: '#B42318' } as const

const STATUS_BADGE: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  not_assigned: { label: 'ยังไม่มีผู้รับ', bg: '#FCEFC7', fg: '#7A4B00' },
  in_process: { label: 'กำลังทำ', bg: '#DCE8F7', fg: '#1F5BAD' },
  done: { label: 'เสร็จ', bg: '#DDF3E6', fg: '#17703F' },
}

const TITLE_MAX = 60
const DAY_MS = 86_400_000

export const REMINDER_TEXT = {
  title: 'แจ้งเตือนงานวันนี้',
  more: (n: number) => `และอีก ${n} งาน ดูได้ใน Dashboard`,
  done: 'เสร็จแล้ว',
  postpone: 'เลื่อนกำหนด', // Figma "UI แก้ V.1", frame 6A
  take: 'ฉันรับเอง',       // Figma 6C: a Task with no owner offers this instead (#45, option ก)
  owner: (name: string) => `คนทำ: ${name}`,
  noOwner: 'ยังไม่มีผู้รับ',
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

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

function clip(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

function bubble(body: unknown[], footer?: unknown[]) {
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'md', contents: footer } } : {}),
  }
}

function button(label: string, data: string, style: 'primary' | 'secondary') {
  const action: LinePostbackAction = { type: 'postback', label, data, displayText: label }
  return { type: 'button', style, color: style === 'primary' ? C.primary : C.primarySoft, height: 'sm', action }
}

function badge(status: TaskStatus) {
  const s = STATUS_BADGE[status]
  return {
    type: 'box', layout: 'horizontal', flex: 0, backgroundColor: s.bg, cornerRadius: 'xxl',
    paddingStart: 'md', paddingEnd: 'md', paddingTop: 'xs', paddingBottom: 'xs',
    contents: [text(`● ${s.label}`, { flex: 0, size: 'xs', color: s.fg, weight: 'bold' })],
  }
}

function summaryBubble(items: ReminderItem[], total: number, now: Date) {
  const c = reasonCounts(items)
  const p = bangkokParts(now)
  const lines = [
    c.overdue ? `เลยกำหนด ${c.overdue} งาน` : null,
    c.dueSoon ? `ครบกำหนดวันนี้-พรุ่งนี้ ${c.dueSoon} งาน` : null,
    c.noAssignee ? `ยังไม่มีผู้รับ ${c.noAssignee} งาน` : null,
    c.noUpdate ? `ไม่มีอัปเดตเกิน 5 วัน ${c.noUpdate} งาน` : null,
  ].filter((x): x is string => x !== null)
  return bubble([
    text(REMINDER_TEXT.title, { weight: 'bold', size: 'md' }),
    text(`${p.d}/${p.m} · ${total} งานที่ต้องดู`, { size: 'xs', color: C.muted }),
    ...lines.map((l) => text(`• ${l}`, { size: 'sm' })),
    ...(total > items.length ? [text(REMINDER_TEXT.more(total - items.length), { size: 'xs', color: C.muted })] : []),
  ])
}

function taskBubble(item: ReminderItem, names: Map<string, string | null>, now: Date) {
  const { task, reasons } = item
  const urgent = reasons[0] === 'overdue' || reasons[0] === 'due_today'
  const owner = task.assigneeLineUserId
    ? REMINDER_TEXT.owner(names.get(task.assigneeLineUserId) ?? 'สมาชิก')
    : REMINDER_TEXT.noOwner
  return bubble(
    [
      text(clip(task.title), { weight: 'bold', size: 'md' }),
      badge(task.status),
      ...reasons.map((r, i) => text(reasonLabel(r, item, now), {
        size: 'xs', color: i === 0 && urgent ? C.red : C.muted, weight: i === 0 ? 'bold' : 'regular',
      })),
      text(owner, { size: 'xs', color: C.muted }),
    ],
    // Done and Postpone belong to the Task's owner (the #39 rule). A Task with no owner has
    // nobody who may answer them, so its next step is someone taking it.
    task.assigneeLineUserId === null
      ? [button(REMINDER_TEXT.take, encodeReminderAction({ kind: 'take', taskId: task.id }), 'primary')]
      : [
          button(REMINDER_TEXT.postpone, encodeReminderAction({ kind: 'postpone', taskId: task.id }), 'secondary'),
          button(REMINDER_TEXT.done, encodeReminderAction({ kind: 'done', taskId: task.id }), 'primary'),
        ],
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
