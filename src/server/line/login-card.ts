import { liffUrl } from '../liff-links'
import { nextStepCard, uri } from './flex-ui'
import type { LineMessage } from './types'

// A card button pressed without a userId (LINE guarantees it only on message events): the
// bot answers with a button to the LIFF login page, which repeats the press as the verified
// person (progress/liff.ts). Used by the progress cards (#7) and the reminder buttons (#45).
// UX review 2.2: a Flex card like every other card, not a LINE template.

export const LOGIN_CARD_TEXT = {
  title: 'ยืนยันตัวตนก่อนนะ',
  body: 'LINE ไม่ได้บอกน้องจดดีว่าใครกด กดปุ่มนี้แล้วน้องจดดีจะบันทึกคำตอบให้',
  button: 'ยืนยันด้วย LINE',
} as const

/** `data` is the pressed button's postback data (IDs only); the LIFF page sends it again. */
export function loginCard(liffId: string, data: string): LineMessage {
  return nextStepCard({
    tone: 'info', title: LOGIN_CARD_TEXT.title, body: LOGIN_CARD_TEXT.body,
    button: uri(LOGIN_CARD_TEXT.button, liffUrl(liffId, 'progress', data)),
  })
}
