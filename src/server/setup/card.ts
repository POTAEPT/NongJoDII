import type { LineMessage, LineUriAction } from '../line/types'
import { liffUrl } from '../liff-links'

// Onboarding cards (#52, Figma Final-Prototype v4): #2a the setup card that answers the
// join event, #2e the "setup done" card after the form is sent. Same look as the weekly
// insight card. Links carry the group's ID only (rules: Baseline).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD', line: '#E6EAF0', badge: '#DCE8F7' } as const

export const SETUP_CARD_TEXT = {
  title: 'สวัสดี น้องจดดีมาแล้วนะ 👋',
  intro: 'น้องจดดีช่วยสรุปงานจากแชต แล้วสร้างเป็นงานให้ทีมกดยืนยันนะ',
  ask: 'ก่อนเริ่ม ขอข้อมูลกลุ่มนิดหนึ่ง จะได้ช่วยได้ตรงกับกลุ่มนี้',
  steps: 'ใช้เวลาประมาณ 1 นาที 4 ข้อ:',
  items: ['กลุ่มนี้ทำเรื่องอะไร', 'ใครทำหน้าที่อะไร', 'อยากให้ NongJoDII ช่วยอะไร', 'ให้เตือนตอนไหน'],
  button: 'ตั้งค่ากลุ่ม',
  footnote: 'แตะแล้วเปิดแบบฟอร์มในแอป LINE',
  altText: 'สวัสดี น้องจดดีมาแล้วนะ 👋 แตะ "ตั้งค่ากลุ่ม" เพื่อเริ่มใช้งาน',
} as const

export const SETUP_DONE_TEXT = {
  title: 'ตั้งค่าเสร็จแล้ว ✓',
  known: 'NongJoDII รู้จักกลุ่มและทีมแล้ว',
  next: 'จากนี้น้องจดดีจะอ่านแชตและร่างงานให้กดยืนยันนะ',
  change: 'เปลี่ยนการตั้งค่าได้ทุกเมื่อ',
  pending: (name: string) => `รอ ${name} ยืนยันเป็นเจ้าของบอท`,
  button: 'ยืนยันเจ้าของบอท',
} as const

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

function numbered(n: number, label: string) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [
      {
        type: 'box', layout: 'vertical', width: '20px', height: '20px', cornerRadius: '10px',
        backgroundColor: C.badge, justifyContent: 'center',
        contents: [text(String(n), { size: 'xxs', weight: 'bold', color: C.primary, align: 'center' })],
      },
      text(label, { flex: 1 }),
    ],
  }
}

function button(action: LineUriAction) {
  return { type: 'button', style: 'primary', color: C.primary, height: 'sm', action }
}

/** #2a: the reply to a join event. `groupId` is groups.id; the button opens the form. */
export function setupCard(p: { liffId: string; groupId: string }): LineMessage {
  const open: LineUriAction = { type: 'uri', label: SETUP_CARD_TEXT.button, uri: liffUrl(p.liffId, 'setup', p.groupId) }
  return {
    type: 'flex',
    altText: SETUP_CARD_TEXT.altText,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          text(SETUP_CARD_TEXT.title, { weight: 'bold', size: 'md' }),
          text(SETUP_CARD_TEXT.intro),
          text(SETUP_CARD_TEXT.ask),
          { type: 'separator', color: C.line },
          text(SETUP_CARD_TEXT.steps, { weight: 'bold' }),
          {
            type: 'box', layout: 'vertical', spacing: 'sm',
            contents: SETUP_CARD_TEXT.items.map((label, i) => numbered(i + 1, label)),
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [button(open), text(SETUP_CARD_TEXT.footnote, { size: 'xxs', color: C.muted, align: 'center' })],
      },
    },
  }
}

/** #2e: pushed after the form is sent. `pendingOwnerName` is the nominee's LINE name while
 *  the Owner has not confirmed; the card then names them and links the Owner confirm page. */
export function setupDoneCard(p: { liffId: string; groupId: string; pendingOwnerName: string | null }): LineMessage {
  const lines = [
    text(SETUP_DONE_TEXT.title, { weight: 'bold', size: 'md' }),
    text(SETUP_DONE_TEXT.known),
    text(SETUP_DONE_TEXT.next),
    text(SETUP_DONE_TEXT.change, { size: 'xs', color: C.muted }),
  ]
  const bubble: Record<string, unknown> = {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: lines },
  }
  if (p.pendingOwnerName !== null) {
    lines.push(text(SETUP_DONE_TEXT.pending(p.pendingOwnerName), { weight: 'bold', color: C.primary }))
    const confirm: LineUriAction = { type: 'uri', label: SETUP_DONE_TEXT.button, uri: liffUrl(p.liffId, 'owner', p.groupId) }
    bubble.footer = { type: 'box', layout: 'vertical', paddingAll: 'md', contents: [button(confirm)] }
  }
  const altText = p.pendingOwnerName !== null
    ? `${SETUP_DONE_TEXT.title} ${SETUP_DONE_TEXT.pending(p.pendingOwnerName)}`
    : `${SETUP_DONE_TEXT.title} ${SETUP_DONE_TEXT.known}`
  return { type: 'flex', altText, contents: bubble }
}
