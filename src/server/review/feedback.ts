import { formatThaiShort } from '../time/bangkok'

/** Every "Tasks created" message starts with this. When a member's LIFF page posts it
 *  into the group (liff.sendMessages), it comes back as their chat message, and the
 *  Summary skips it so the AI never proposes those Tasks again. */
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
