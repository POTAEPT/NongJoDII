import { badge, bubble, button, header, keyValue, panel, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { unownedTaskFooter } from '../tasks/card'
import { formatThaiShort } from '../time/bangkok'

/** Every "Tasks created" message starts with this. The bot pushes it, so it does
 *  not come back through the webhook; if a member forwards or pastes it into the
 *  chat, the Summary still skips it, so the AI never proposes those Tasks again. */
export const TASK_FEEDBACK_PREFIX = '✅ สร้างงานแล้ว'

const TEXT_MAX = 5000

export type CreatedTask = { title: string; assigneeName: string | null; assigned: boolean; dueAt: Date | null }

export function isTaskFeedback(text: string): boolean {
  return text.startsWith(TASK_FEEDBACK_PREFIX)
}

/** The group message after Tasks are created. Names are LINE names only (rule 9). */
export function buildTaskFeedback(tasks: CreatedTask[]): string {
  const items = tasks.map((t, i) => {
    const assignee = t.assigned ? (t.assigneeName ?? 'สมาชิก') : 'ยังไม่มีผู้รับ'
    const due = t.dueAt ? formatThaiShort(t.dueAt) : 'ไม่ระบุ'
    return `${i + 1}. ${t.title}\n   ผู้รับ: ${assignee} · กำหนด: ${due}`
  })
  return `${TASK_FEEDBACK_PREFIX} ${tasks.length} งาน\n${items.join('\n')}`.slice(0, TEXT_MAX)
}

/** LINE caps a Flex message's altText at 400 characters. */
const ALT_MAX = 400

export type AnnouncedTask = CreatedTask & { taskId: string }

/** The group card after Tasks are created (Figma UI v4 #4): one bubble per Task with its
 *  due date and status. An owned Task gets "แก้งาน" (the LIFF Task page); an unowned one gets
 *  มอบหมาย, ฉันรับเอง and ไม่ใช่งาน (#23, tasks/card.ts).
 *  The altText is the text message above, so notifications and forwards keep the prefix. */
export function buildTaskFeedbackCard(tasks: AnnouncedTask[], liffId: string): LineMessage {
  const bubbles = tasks.map((t) => {
    const edit = uri('แก้งาน', liffUrl(liffId, 'task', t.taskId))
    const due = t.dueAt ? formatThaiShort(t.dueAt) : 'ไม่ระบุ'
    return bubble(
      [
        header('success', 'สร้างงานแล้ว'),
        panel([
          text(t.title, { weight: 'bold' }),
          keyValue('กำหนดส่ง', due),
          ...(t.assigned ? [keyValue('ผู้รับ', t.assigneeName ?? 'สมาชิก')] : []),
          { type: 'box', layout: 'horizontal', contents: [badge(t.assigned ? 'in_process' : 'not_assigned'), { type: 'filler' }] },
        ]),
        ...(t.assigned ? [] : [text('งานนี้ยังไม่มีผู้รับ', { color: '#545454' })]),
      ],
      t.assigned ? [button('secondary', edit)] : unownedTaskFooter(t.taskId, liffId),
    )
  })
  const altText = buildTaskFeedback(tasks)
  return {
    type: 'flex',
    altText: altText.length > ALT_MAX ? `${altText.slice(0, ALT_MAX - 1)}…` : altText,
    contents: bubbles.length === 1 ? bubbles[0] : { type: 'carousel', contents: bubbles },
  }
}
