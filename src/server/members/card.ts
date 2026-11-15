import { badge, bubble, button, buttonRow, caption, header, postback, text, title, uri } from '../line/flex-ui'
import { liffUrl } from '../liff-links'
import type { LineMessage } from '../line/types'
import type { TaskRow } from '../ports'
import { encodeReminderAction } from '../reminders/postback'
import { bangkokParts } from '../time/bangkok'

// #29 The card posted when people leave a group: their open Tasks went back to Not Assigned,
// each with Assign (the LIFF Task page, #23) and "ฉันรับเอง" (the same button and rules as the
// reminder cards, #45). One Flex carousel, so one push. Same look as the reminder cards
// (Figma UI v4 design system). Cards show LINE names, never nicknames (decided 2026-11-11).

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
  assign: 'มอบหมายงาน',
  take: 'ฉันรับเอง',
} as const

function taskBubble(task: TaskRow, liffId: string) {
  const name = task.title.length > TITLE_MAX ? `${task.title.slice(0, TITLE_MAX - 1)}…` : task.title
  return bubble(
    [
      title(name),
      { type: 'box', layout: 'horizontal', contents: [badge('not_assigned'), { type: 'filler' }] },
      ...(task.dueAt ? [caption(MEMBER_LEFT_TEXT.due(task.dueAt))] : []),
    ],
    [buttonRow(
      button('secondary', uri(MEMBER_LEFT_TEXT.assign, liffUrl(liffId, 'task', task.id))),
      button('primary', postback(MEMBER_LEFT_TEXT.take, encodeReminderAction({ kind: 'take', taskId: task.id }))),
    )],
  )
}

/** `names`: the LINE names of the people who left. Call only with at least one Task. */
export function memberLeftCard(p: { names: string[]; tasks: TaskRow[]; liffId: string }): LineMessage {
  const { names, tasks, liffId } = p
  if (tasks.length === 0) throw new Error('memberLeftCard needs at least one Task')
  const shown = tasks.slice(0, MEMBER_LEFT_MAX_TASKS)
  const summary = bubble([
    header('warning', MEMBER_LEFT_TEXT.title(names)),
    text(MEMBER_LEFT_TEXT.body(tasks.length), { color: '#545454' }),
    ...(tasks.length > shown.length ? [caption(MEMBER_LEFT_TEXT.more(tasks.length - shown.length))] : []),
  ])
  return {
    type: 'flex',
    altText: `${MEMBER_LEFT_TEXT.title(names)}: ${MEMBER_LEFT_TEXT.body(tasks.length)}`,
    contents: { type: 'carousel', contents: [summary, ...shown.map((t) => taskBubble(t, liffId))] },
  }
}
