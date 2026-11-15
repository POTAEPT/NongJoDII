import { liffUrl } from '../liff-links'
import { badge, bubble, button, buttonRow, caption, filler, header, postback, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { encodeReminderAction } from '../reminders/postback'

// #23 The buttons of an unowned Task in the group, and the replies of "ไม่ใช่งาน":
//   มอบหมาย   opens the LIFF Task page, where a Member picks the owner.
//   ฉันรับเอง  the reminder cards' take postback (#45): the presser becomes the owner.
//   ไม่ใช่งาน   asks for a confirm; "ลบงาน" soft-deletes the Task and the reply offers "กู้คืน".
// Every answer is a reply (free), never a push.

export const TASK_ACTION_TEXT = {
  assign: 'มอบหมาย',
  take: 'ฉันรับเอง',
  discard: 'ไม่ใช่งาน',
  confirmTitle: 'ลบงานนี้ไหม?',
  confirmBody: 'งานนี้จะหายจากรายการงาน การเตือน และ Dashboard กดกู้คืนได้ภายหลัง',
  confirmYes: 'ลบงาน',
  confirmNo: 'ไม่ลบ',
  kept: (title: string) => `ไม่ได้ลบ “${title}” งานยังอยู่เหมือนเดิม`,
  deleted: (title: string) => `ลบงาน “${title}” แล้ว`,
  deletedTitle: 'ลบงานแล้ว',
  deletedBody: 'ถ้าลบผิด กดกู้คืนได้เลย',
  restore: 'กู้คืน',
  restored: (title: string) => `กู้คืนงาน “${title}” แล้ว`,
  restoredTitle: 'กู้คืนงานแล้ว',
  notDeleted: 'งานนี้ยังอยู่ ไม่ต้องกู้คืน',
} as const

const TITLE_MAX = 60
const clip = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s)

/** มอบหมาย and ฉันรับเอง side by side, "ไม่ใช่งาน" under them. */
export function unownedTaskFooter(taskId: string, liffId: string): Record<string, unknown>[] {
  return [
    buttonRow(
      button('secondary', uri(TASK_ACTION_TEXT.assign, liffUrl(liffId, 'task', taskId))),
      button('primary', postback(TASK_ACTION_TEXT.take, encodeReminderAction({ kind: 'take', taskId }))),
    ),
    button('ghost', postback(TASK_ACTION_TEXT.discard, encodeReminderAction({ kind: 'discard', taskId }))),
  ]
}

export function discardConfirmCard(task: { id: string; title: string }): LineMessage {
  return {
    type: 'flex',
    altText: `${TASK_ACTION_TEXT.confirmTitle} “${task.title}”`,
    contents: bubble(
      [header('danger', TASK_ACTION_TEXT.confirmTitle), caption(clip(task.title), { size: 'sm' }), text(TASK_ACTION_TEXT.confirmBody, { color: '#545454' })],
      [buttonRow(
        button('outline', postback(TASK_ACTION_TEXT.confirmNo, encodeReminderAction({ kind: 'discard_no', taskId: task.id }))),
        button('danger', postback(TASK_ACTION_TEXT.confirmYes, encodeReminderAction({ kind: 'discard_yes', taskId: task.id }))),
      )],
    ),
  }
}

export function deletedCard(task: { id: string; title: string }): LineMessage {
  return {
    type: 'flex',
    altText: TASK_ACTION_TEXT.deleted(task.title),
    contents: bubble(
      [header('success', TASK_ACTION_TEXT.deletedTitle), caption(clip(task.title), { size: 'sm' }), text(TASK_ACTION_TEXT.deletedBody, { color: '#545454' })],
      [button('outline', postback(TASK_ACTION_TEXT.restore, encodeReminderAction({ kind: 'restore', taskId: task.id })))],
    ),
  }
}

/** The restored Task is unowned again, so it gets the same buttons as on the created card. */
export function restoredCard(task: { id: string; title: string }, liffId: string): LineMessage {
  return {
    type: 'flex',
    altText: TASK_ACTION_TEXT.restored(task.title),
    contents: bubble(
      [
        header('success', TASK_ACTION_TEXT.restoredTitle),
        caption(clip(task.title), { size: 'sm' }),
        { type: 'box', layout: 'horizontal', contents: [badge('not_assigned'), filler()] },
      ],
      unownedTaskFooter(task.id, liffId),
    ),
  }
}
