import { badge, bubble, button, buttonRow, caption, column, header, postback, statusChange, text, title } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import type { ProgressPromptRow, ProgressTarget, TaskRow } from '../ports'
import { bangkokParts, formatThaiShort } from '../time/bangkok'
import { encodeProgressAction } from './postback'

// LINE Flex cards of Track progress, after Figma "UI v4" frames
// "#5 ถามยืนยันปิดงาน · ข้อความชัด", "#5 ถามยืนยัน · ไม่แน่ใจว่างานไหน" and
// "#5 หลังยืนยัน + เสนอผู้รับงาน". Cards show LINE names, never nicknames.

const LABEL_MAX = 40 // LINE action label limit

export const PROGRESS_TEXT = {
  askDone: 'อัปเดตงานนี้ไหม?',
  askTake: (name: string) => `ให้ ${name} รับงานนี้ไหม?`,
  from: (name: string, at: string) => `จากข้อความของ ${name} · ${at}`,
  owner: (name: string, due: string) => `ผู้รับ: ${name} · ${due}`,
  noDue: 'ยังไม่มีกำหนดส่ง',
  due: (d: string) => `กำหนดส่ง ${d}`,
  no: 'ไม่ใช่',
  yesDone: 'ใช่ ปิดงาน',
  yesTake: 'ใช่ รับงาน',
  wrongTask: 'เลือกงานอื่น',
  pickTitle: 'อัปเดตนี้หมายถึงงานไหน?',
  pickDone: 'เลือกงานที่เสร็จ แล้วน้องจดดีจะปิดให้',
  pickStart: 'เลือกงานที่เริ่มทำ แล้วน้องจดดีจะอัปเดตให้',
  notUpdate: 'ไม่ใช่การอัปเดตงาน',
  closed: (t: string) => `ปิดงาน “${t}” แล้ว`,
  taken: (t: string) => `รับงาน “${t}” แล้ว`,
  confirmedBy: (name: string, at: string) => `ยืนยันโดย ${name} · ${at}`,
} as const

export function hhmm(d: Date): string {
  const p = bangkokParts(d)
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

function clip(t: string): string {
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t
}

/** Asks one person to confirm one Task's new status. */
export function progressCard(p: { prompt: ProgressPromptRow; task: TaskRow; senderName: string; sentAt: Date }): LineMessage {
  const { prompt, task, senderName, sentAt } = p
  const yes = encodeProgressAction({ kind: 'answer', promptId: prompt.id, answer: 'yes' })
  const no = encodeProgressAction({ kind: 'answer', promptId: prompt.id, answer: 'no' })

  if (prompt.targetStatus === 'in_process') {
    const due = task.dueAt ? PROGRESS_TEXT.due(formatThaiShort(task.dueAt)) : PROGRESS_TEXT.noDue
    const head = PROGRESS_TEXT.askTake(senderName)
    return {
      type: 'flex', altText: head,
      contents: bubble([
        header('info', head),
        title(task.title),
        statusChange(task.status, 'in_process'),
        caption(PROGRESS_TEXT.owner(senderName, due)),
        buttonRow(button('secondary', postback(PROGRESS_TEXT.no, no)), button('primary', postback(PROGRESS_TEXT.yesTake, yes))),
      ]),
    }
  }

  return {
    type: 'flex', altText: PROGRESS_TEXT.askDone,
    contents: bubble([
      header('info', PROGRESS_TEXT.askDone),
      title(task.title),
      statusChange(task.status, 'done'),
      caption(PROGRESS_TEXT.from(senderName, hhmm(sentAt))),
      buttonRow(button('secondary', postback(PROGRESS_TEXT.no, no)), button('primary', postback(PROGRESS_TEXT.yesDone, yes))),
      button('ghost', postback(PROGRESS_TEXT.wrongTask, encodeProgressAction({ kind: 'wrong_task', promptId: prompt.id }))),
    ]),
  }
}

/** "อัปเดตนี้หมายถึงงานไหน?": one button per candidate Task. */
export function pickerCard(p: { messageId: string; tasks: TaskRow[]; targetStatus: ProgressTarget }): LineMessage {
  const { messageId, tasks, targetStatus } = p
  const hint = targetStatus === 'done' ? PROGRESS_TEXT.pickDone : PROGRESS_TEXT.pickStart
  return {
    type: 'flex', altText: PROGRESS_TEXT.pickTitle,
    contents: bubble([
      header('info', PROGRESS_TEXT.pickTitle),
      text(hint, { color: '#545454' }),
      column(tasks.map((t) =>
        button('outline', postback(clip(t.title), encodeProgressAction({ kind: 'pick', messageId, taskId: t.id, targetStatus }))))),
      button('ghost', postback(PROGRESS_TEXT.notUpdate, encodeProgressAction({ kind: 'not_update', messageId }))),
    ]),
  }
}

/** After a Yes: "ปิดงาน “ทำสไลด์คู่แข่ง” แล้ว · ยืนยันโดย บิว · 14:21". */
export function resultCard(p: {
  task: TaskRow; status: ProgressTarget; confirmedByName: string; assigneeName: string | null; at: Date
}): LineMessage {
  const { task, status, confirmedByName, assigneeName, at } = p
  const headline = status === 'done' ? PROGRESS_TEXT.closed(task.title) : PROGRESS_TEXT.taken(task.title)
  const who = status === 'in_process' && assigneeName ? `ผู้รับ: ${assigneeName} · ` : ''
  return {
    type: 'flex', altText: headline,
    contents: bubble([
      header('success', headline),
      ...(status === 'in_process' ? [{ type: 'box', layout: 'horizontal', contents: [badge('in_process'), { type: 'filler' }] }] : []),
      caption(`${who}${PROGRESS_TEXT.confirmedBy(confirmedByName, hhmm(at))}`),
    ]),
  }
}

export const PROGRESS_REPLY = {
  notAllowed: (names: string[]) => `เฉพาะ ${names.join(' หรือ ')} ที่ยืนยันงานนี้ได้`,
  alreadyAnswered: 'การ์ดนี้มีคนตอบไปแล้ว',
  taskClosed: 'งานนี้ถูกปิดไปแล้ว',
  taskGone: 'งานนี้ถูกลบหรือเปลี่ยนไปแล้ว น้องจดดีไม่ได้เปลี่ยนอะไร',
  keptAsIs: 'โอเค น้องจดดีไม่เปลี่ยนสถานะงาน',
  notUpdate: 'โอเค ไม่ใช่การอัปเดตงาน น้องจดดีปิดรายการนี้แล้ว',
  pickerClosed: 'รายการนี้ปิดไปแล้ว เพราะมีคนกด "ไม่ใช่การอัปเดตงาน" น้องจดดีไม่ได้เปลี่ยนอะไร',
  notAllowedDismiss: (name: string) => `เฉพาะ ${name} ที่ปิดรายการนี้ได้`,
  noOtherTask: 'ไม่มีงานอื่นที่ยังไม่เสร็จในกลุ่มนี้',
  openCardExists: 'มีการ์ดถามงานนี้อยู่แล้ว กดตอบที่การ์ดนั้นได้เลย',
  cardExpired: 'การ์ดนี้หมดอายุแล้ว พิมพ์อัปเดตงานอีกครั้งได้เลย',
  needsLogin: 'LINE ไม่ได้บอกน้องจดดีว่าใครกด กดปุ่มด้านล่างเพื่อยืนยันตัวตนแล้วน้องจดดีจะบันทึกคำตอบให้',
} as const

export function textMessage(t: string): LineMessage {
  return { type: 'text', text: t }
}
