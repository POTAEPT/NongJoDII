import type { LineMessage, LinePostbackAction } from '../line/types'
import type { ProgressPromptRow, ProgressTarget, TaskRow, TaskStatus } from '../ports'
import { bangkokParts, formatThaiShort } from '../time/bangkok'
import { encodeProgressAction } from './postback'

// LINE Flex cards of Track progress, after Figma "UI v4" frames
// "#5 ถามยืนยันปิดงาน · ข้อความชัด", "#5 ถามยืนยัน · ไม่แน่ใจว่างานไหน" and
// "#5 หลังยืนยัน + เสนอผู้รับงาน". Cards show LINE names, never nicknames.

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD', primarySoft: '#DCE8F7', green: '#1E9E5A' } as const

const STATUS_BADGE: Record<TaskStatus, { label: string; bg: string; fg: string }> = {
  not_assigned: { label: 'ยังไม่มีคนทำ', bg: '#FCEFC7', fg: '#7A4B00' },
  in_process: { label: 'กำลังทำ', bg: '#DCE8F7', fg: '#1F5BAD' },
  done: { label: 'เสร็จ', bg: '#DDF3E6', fg: '#17703F' },
}

const LABEL_MAX = 40 // LINE button label limit

export function hhmm(d: Date): string {
  const p = bangkokParts(d)
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

function header(t: string) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm',
    contents: [text('✦', { flex: 0, color: C.primary, weight: 'bold' }), text(t, { weight: 'bold', size: 'md' })],
  }
}

function badge(status: TaskStatus) {
  const s = STATUS_BADGE[status]
  return {
    type: 'box', layout: 'horizontal', flex: 0, backgroundColor: s.bg, cornerRadius: 'xxl',
    paddingStart: 'md', paddingEnd: 'md', paddingTop: 'xs', paddingBottom: 'xs',
    contents: [text(`● ${s.label}`, { flex: 0, size: 'xs', color: s.fg, weight: 'bold' })],
  }
}

function statusChange(from: TaskStatus, to: TaskStatus) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'md', alignItems: 'center',
    contents: [badge(from), text('›', { flex: 0, color: C.muted, size: 'md' }), badge(to)],
  }
}

function button(label: string, data: string, style: 'primary' | 'secondary' | 'link') {
  const action: LinePostbackAction = { type: 'postback', label, data, displayText: label }
  const color = style === 'secondary' ? C.primarySoft : C.primary
  return { type: 'button', style, color, height: 'sm', action }
}

function row(...contents: unknown[]) {
  return { type: 'box', layout: 'horizontal', spacing: 'sm', contents }
}

function bubble(body: unknown[]) {
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: body },
  }
}

/** Asks one person to confirm one Task's new status. */
export function progressCard(p: { prompt: ProgressPromptRow; task: TaskRow; senderName: string; sentAt: Date }): LineMessage {
  const { prompt, task, senderName, sentAt } = p
  const yes = encodeProgressAction({ kind: 'answer', promptId: prompt.id, answer: 'yes' })
  const no = encodeProgressAction({ kind: 'answer', promptId: prompt.id, answer: 'no' })

  if (prompt.targetStatus === 'in_process') {
    const due = task.dueAt ? `กำหนดส่ง ${formatThaiShort(task.dueAt)}` : 'ยังไม่มีกำหนดส่ง'
    const title = `${senderName} รับงานนี้ใช่ไหม?`
    return {
      type: 'flex', altText: title,
      contents: bubble([
        header(title),
        text(task.title, { weight: 'bold', size: 'lg' }),
        statusChange(task.status, 'in_process'),
        text(`คนทำ: ${senderName} · ${due}`, { size: 'xs', color: C.muted }),
        row(button('ไม่รับ', no, 'secondary'), button('ใช่ รับงาน', yes, 'primary')),
      ]),
    }
  }

  return {
    type: 'flex', altText: 'อัปเดตงานนี้ไหม?',
    contents: bubble([
      header('อัปเดตงานนี้ไหม?'),
      text(task.title, { weight: 'bold', size: 'lg' }),
      statusChange(task.status, 'done'),
      text(`จากข้อความของ ${senderName} · ${hhmm(sentAt)}`, { size: 'xs', color: C.muted }),
      row(button('ยังไม่เสร็จ', no, 'secondary'), button('ใช่ เสร็จแล้ว', yes, 'primary')),
      button('ผิดงาน · เลือกงานอื่น', encodeProgressAction({ kind: 'wrong_task', promptId: prompt.id }), 'link'),
    ]),
  }
}

/** "อัปเดตนี้หมายถึงงานไหน?": one button per candidate Task. */
export function pickerCard(p: { messageId: string; tasks: TaskRow[]; targetStatus: ProgressTarget }): LineMessage {
  const { messageId, tasks, targetStatus } = p
  const hint = targetStatus === 'done' ? 'เลือกงานที่เสร็จ แล้วน้องจดดีจะปิดให้' : 'เลือกงานที่เริ่มทำ แล้วน้องจดดีจะอัปเดตให้'
  return {
    type: 'flex', altText: 'อัปเดตนี้หมายถึงงานไหน?',
    contents: bubble([
      header('อัปเดตนี้หมายถึงงานไหน?'),
      text(hint, { size: 'xs', color: C.muted }),
      ...tasks.map((t) =>
        button(
          t.title.length > LABEL_MAX ? `${t.title.slice(0, LABEL_MAX - 1)}…` : t.title,
          encodeProgressAction({ kind: 'pick', messageId, taskId: t.id, targetStatus }),
          'secondary',
        )),
      button('ไม่ใช่การอัปเดตงาน', encodeProgressAction({ kind: 'not_update', messageId }), 'link'),
    ]),
  }
}

/** After a Yes: "“ทำสไลด์คู่แข่ง” เสร็จแล้ว · ยืนยันโดย บิว · 14:21". */
export function resultCard(p: {
  task: TaskRow; status: ProgressTarget; confirmedByName: string; assigneeName: string | null; at: Date
}): LineMessage {
  const { task, status, confirmedByName, assigneeName, at } = p
  const headline = status === 'done' ? `“${task.title}” เสร็จแล้ว` : `“${task.title}” กำลังทำ`
  const who = status === 'in_process' && assigneeName ? `คนทำ: ${assigneeName} · ` : ''
  return {
    type: 'flex', altText: headline,
    contents: bubble([
      row(
        text(status === 'done' ? '✓' : '●', { flex: 0, color: status === 'done' ? C.green : C.primary, weight: 'bold' }),
        text(headline, { weight: 'bold', size: 'md' }),
      ),
      text(`${who}ยืนยันโดย ${confirmedByName} · ${hhmm(at)}`, { size: 'xs', color: C.muted }),
    ]),
  }
}

export const PROGRESS_REPLY = {
  noUserId: 'กดยืนยันได้จากแอป LINE บนมือถือเท่านั้น น้องจดดียังไม่ได้เปลี่ยนสถานะงาน',
  notAllowed: (names: string[]) => `เฉพาะ ${names.join(' หรือ ')} ที่ยืนยันงานนี้ได้`,
  alreadyAnswered: 'การ์ดนี้มีคนตอบไปแล้ว',
  taskGone: 'งานนี้ถูกลบหรือเปลี่ยนไปแล้ว น้องจดดีไม่ได้เปลี่ยนอะไร',
  keptAsIs: 'โอเค น้องจดดีไม่เปลี่ยนสถานะงาน',
  notUpdate: 'โอเค ไม่ใช่การอัปเดตงาน',
  noOtherTask: 'ไม่มีงานอื่นที่ยังไม่เสร็จในกลุ่มนี้',
  openCardExists: 'มีการ์ดถามงานนี้อยู่แล้ว กดตอบที่การ์ดนั้นได้เลย',
} as const

export function textMessage(t: string): LineMessage {
  return { type: 'text', text: t }
}
