import { liffUrl } from '../liff-links'
import type { LineMessage, LinePostbackAction, LineUriAction } from '../line/types'
import type { TaskRow } from '../ports'
import { encodeReminderAction } from '../reminders/postback'
import { bangkokParts } from '../time/bangkok'

// #29 The card posted when people leave a group: their open Tasks went back to Not Assigned,
// each with Assign (the LIFF Task page, #23) and "ฉันรับเอง" (the same button and rules as the
// reminder cards, #45). One Flex carousel, so one push. Same look as the reminder cards.
// Cards show LINE names, never nicknames (decided 2026-11-11).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD', primarySoft: '#DCE8F7' } as const
const TITLE_MAX = 60
/** LINE allows 12 bubbles in a carousel: the summary plus 11 Tasks. */
export const MEMBER_LEFT_MAX_TASKS = 11

export const MEMBER_LEFT_TEXT = {
  title: (names: string[]) => `${names.join(', ')} ออกจากกลุ่มแล้ว`,
  body: (n: number) => `งานที่ยังไม่เสร็จ ${n} งานกลับเป็น “ยังไม่มีผู้รับ” ใครจะรับต่อ?`,
  more: (n: number) => `และอีก ${n} งาน ดูได้ใน Dashboard`,
  noOwner: 'ยังไม่มีผู้รับ',
  due: (d: Date) => {
    const p = bangkokParts(d)
    return `กำหนด ${p.d}/${p.m} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
  },
  assign: 'มอบหมาย',
  take: 'ฉันรับเอง',
} as const

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

function bubble(body: unknown[], footer?: unknown[]) {
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body },
    ...(footer ? { footer: { type: 'box', layout: 'horizontal', spacing: 'sm', paddingAll: 'md', contents: footer } } : {}),
  }
}

function taskBubble(task: TaskRow, liffId: string) {
  const title = task.title.length > TITLE_MAX ? `${task.title.slice(0, TITLE_MAX - 1)}…` : task.title
  const assign: LineUriAction = { type: 'uri', label: MEMBER_LEFT_TEXT.assign, uri: liffUrl(liffId, 'task', task.id) }
  const take: LinePostbackAction = {
    type: 'postback', label: MEMBER_LEFT_TEXT.take, data: encodeReminderAction({ kind: 'take', taskId: task.id }),
    displayText: MEMBER_LEFT_TEXT.take,
  }
  return bubble(
    [
      text(title, { weight: 'bold', size: 'md' }),
      {
        type: 'box', layout: 'horizontal', flex: 0, backgroundColor: '#FCEFC7', cornerRadius: 'xxl',
        paddingStart: 'md', paddingEnd: 'md', paddingTop: 'xs', paddingBottom: 'xs',
        contents: [text(`● ${MEMBER_LEFT_TEXT.noOwner}`, { flex: 0, size: 'xs', color: '#7A4B00', weight: 'bold' })],
      },
      ...(task.dueAt ? [text(MEMBER_LEFT_TEXT.due(task.dueAt), { size: 'xs', color: C.muted })] : []),
    ],
    [
      { type: 'button', style: 'secondary', color: C.primarySoft, height: 'sm', action: assign },
      { type: 'button', style: 'primary', color: C.primary, height: 'sm', action: take },
    ],
  )
}

/** `names`: the LINE names of the people who left. Call only with at least one Task. */
export function memberLeftCard(p: { names: string[]; tasks: TaskRow[]; liffId: string }): LineMessage {
  const { names, tasks, liffId } = p
  if (tasks.length === 0) throw new Error('memberLeftCard needs at least one Task')
  const shown = tasks.slice(0, MEMBER_LEFT_MAX_TASKS)
  const summary = bubble([
    text(MEMBER_LEFT_TEXT.title(names), { weight: 'bold', size: 'md' }),
    text(MEMBER_LEFT_TEXT.body(tasks.length)),
    ...(tasks.length > shown.length ? [text(MEMBER_LEFT_TEXT.more(tasks.length - shown.length), { size: 'xs', color: C.muted })] : []),
  ])
  return {
    type: 'flex',
    altText: `${MEMBER_LEFT_TEXT.title(names)}: ${MEMBER_LEFT_TEXT.body(tasks.length)}`,
    contents: { type: 'carousel', contents: [summary, ...shown.map((t) => taskBubble(t, liffId))] },
  }
}
