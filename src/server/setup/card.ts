import { bubble, button, caption, column, header, numbered, panel, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'

// Onboarding cards (#52, Figma UI v4): #2a the setup card that answers the join event, #2e
// the "setup done" card after the form is sent. Links carry the group's ID only (rules:
// Baseline).

export const SETUP_CARD_TEXT = {
  title: 'สวัสดี น้องจดดีมาแล้วนะ',
  intro: 'น้องจดดีช่วยสรุปงานจากแชต แล้วสร้างเป็นงานให้ทีมกดยืนยันนะ',
  ask: 'ก่อนเริ่ม ขอข้อมูลกลุ่มนิดหนึ่ง จะได้ช่วยได้ตรงกับกลุ่มนี้',
  steps: 'ใช้เวลาประมาณ 1 นาที · 4 ข้อ',
  items: ['กลุ่มนี้ทำเรื่องอะไร', 'ใครทำหน้าที่อะไร', 'อยากให้น้องจดดีช่วยอะไร', 'ให้เตือนตอนไหน'],
  button: 'ตั้งค่ากลุ่ม',
  footnote: 'แตะแล้วเปิดแบบฟอร์มในแอป LINE',
  altText: 'สวัสดี น้องจดดีมาแล้วนะ แตะ "ตั้งค่ากลุ่ม" เพื่อเริ่มใช้งาน',
} as const

export const SETUP_DONE_TEXT = {
  title: 'ตั้งค่าเสร็จแล้ว',
  known: 'น้องจดดีรู้จักกลุ่มและทีมแล้ว',
  next: 'จากนี้น้องจดดีจะอ่านแชตและร่างงานให้กดยืนยันนะ',
  change: 'เปลี่ยนการตั้งค่าได้ทุกเมื่อ',
  pending: (name: string) => `รอ ${name} ยืนยันเป็นเจ้าของบอท`,
  button: 'ยืนยันเจ้าของบอท',
  settings: 'เปิดการตั้งค่า',
} as const

/** #2a: the reply to a join event. `groupId` is groups.id; the button opens the form. */
export function setupCard(p: { liffId: string; groupId: string }): LineMessage {
  const open = uri(SETUP_CARD_TEXT.button, liffUrl(p.liffId, 'setup', p.groupId))
  return {
    type: 'flex',
    altText: SETUP_CARD_TEXT.altText,
    contents: bubble(
      [
        header('info', SETUP_CARD_TEXT.title),
        text(SETUP_CARD_TEXT.intro, { color: '#545454' }),
        text(SETUP_CARD_TEXT.ask, { color: '#545454' }),
        panel([
          caption(SETUP_CARD_TEXT.steps),
          column(SETUP_CARD_TEXT.items.map((label, i) => numbered(i + 1, label))),
        ]),
      ],
      [button('primary', open), caption(SETUP_CARD_TEXT.footnote, { size: 'xxs', align: 'center' })],
    ),
  }
}

/** #2e: pushed after the form is sent. `pendingOwnerName` is the nominee's LINE name while
 *  the Owner has not confirmed; the card then names them and links the Owner confirm page.
 *  The card always links the group's Settings (#80), since it says the settings can change
 *  any time: the main button once the Owner is confirmed, a second one while it is pending. */
export function setupDoneCard(p: { liffId: string; groupId: string; pendingOwnerName: string | null }): LineMessage {
  const body = [
    header('success', SETUP_DONE_TEXT.title),
    text(`${SETUP_DONE_TEXT.known} ${SETUP_DONE_TEXT.next}`, { color: '#545454' }),
    caption(SETUP_DONE_TEXT.change),
  ]
  const footer = []
  const settings = uri(SETUP_DONE_TEXT.settings, liffUrl(p.liffId, 'settings', p.groupId))
  if (p.pendingOwnerName !== null) {
    body.push(panel([text(SETUP_DONE_TEXT.pending(p.pendingOwnerName), { weight: 'bold', color: '#1F5FB0' })]))
    footer.push(button('primary', uri(SETUP_DONE_TEXT.button, liffUrl(p.liffId, 'owner', p.groupId))))
    footer.push(button('secondary', settings))
  } else {
    footer.push(button('primary', settings))
  }
  const altText = p.pendingOwnerName !== null
    ? `${SETUP_DONE_TEXT.title} ${SETUP_DONE_TEXT.pending(p.pendingOwnerName)}`
    : `${SETUP_DONE_TEXT.title} ${SETUP_DONE_TEXT.known}`
  return { type: 'flex', altText, contents: bubble(body, footer) }
}
