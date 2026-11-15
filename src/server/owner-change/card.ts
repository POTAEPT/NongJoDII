import { liffUrl } from '../liff-links'
import { bubble, button, caption, header, panel, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'

// #31 cards. Links carry groups.id only (rules: Baseline); names are LINE names.

export const TAKEOVER_CARD_TEXT = {
  title: 'เปลี่ยนเจ้าของบอทแล้ว',
  changed: (name: string) => `${name} เป็นเจ้าของบอทของโปรเจกต์นี้แล้ว`,
  paused: (n: number) => `กลุ่มย่อย ${n} กลุ่มหยุดเก็บไฟล์และสรุปไว้ก่อน รอเจ้าของบอทคนใหม่ตอบว่าจะดูแลกลุ่มย่อยต่อไหม`,
  expiry: 'ถ้าไม่ตอบภายใน 7 วัน กลุ่มย่อยจะแยกออกจากโปรเจกต์ และต้องตั้งค่าใหม่',
  button: 'ตอบคำถาม',
} as const

export const DETACHED_CARD_TEXT = {
  title: 'กลุ่มนี้แยกออกจากโปรเจกต์แล้ว',
  body: 'โปรเจกต์หลักเปลี่ยนเจ้าของบอท และกลุ่มนี้ไม่ได้ย้ายไปด้วย งานในกลุ่มยังอยู่ครบ',
  next: 'ตั้งค่ากลุ่มและเลือกเจ้าของบอทใหม่ แล้วน้องจดดีจะเก็บไฟล์และสรุปให้ต่อ',
  button: 'ตั้งค่ากลุ่ม',
} as const

/** Pushed in the main group after the new Owner confirmed: opens the take-over question. */
export function takeoverCard(p: { liffId: string; mainGroupId: string; ownerName: string; subGroups: number }): LineMessage {
  return {
    type: 'flex',
    altText: `${TAKEOVER_CARD_TEXT.title} ${TAKEOVER_CARD_TEXT.paused(p.subGroups)}`,
    contents: bubble(
      [
        header('info', TAKEOVER_CARD_TEXT.title),
        text(TAKEOVER_CARD_TEXT.changed(p.ownerName), { weight: 'bold' }),
        text(TAKEOVER_CARD_TEXT.paused(p.subGroups), { color: '#545454' }),
        panel([caption(TAKEOVER_CARD_TEXT.expiry)]),
      ],
      [button('primary', uri(TAKEOVER_CARD_TEXT.button, liffUrl(p.liffId, 'takeover', p.mainGroupId)))],
    ),
  }
}

/** Pushed in a Sub group that detached: it needs its own setup and Owner (#52 form). */
export function detachedCard(p: { liffId: string; groupId: string }): LineMessage {
  return {
    type: 'flex',
    altText: `${DETACHED_CARD_TEXT.title} ${DETACHED_CARD_TEXT.next}`,
    contents: bubble(
      [
        header('warning', DETACHED_CARD_TEXT.title),
        text(DETACHED_CARD_TEXT.body, { color: '#545454' }),
        text(DETACHED_CARD_TEXT.next, { color: '#545454' }),
      ],
      [button('primary', uri(DETACHED_CARD_TEXT.button, liffUrl(p.liffId, 'setup', p.groupId)))],
    ),
  }
}
