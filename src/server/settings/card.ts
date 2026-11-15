import { log, logError } from '../log'
import { bubble, button, caption, header, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import type { Deps } from '../ports'

// #28: the answer to "NongJoDII ตั้งค่า" in a group. A reply (never a push, so no quota)
// with one button that opens Settings for that group. Anyone may ask; the page itself lets
// only the confirmed Owner change values. Same look as the setup card (setup/card.ts).

export const SETTINGS_CARD_TEXT = {
  title: 'การตั้งค่ากลุ่ม',
  body: 'ดูและแก้สิ่งที่ตั้งไว้ตอนเริ่มใช้: เรื่องที่กลุ่มทำ ชื่อเล่นและหน้าที่ ฟีเจอร์ และเวลาเตือน',
  button: 'เปิดการตั้งค่า',
  footnote: 'เจ้าของบอทแก้ได้ สมาชิกคนอื่นดูได้อย่างเดียว',
  altText: 'การตั้งค่ากลุ่ม: แตะ "เปิดการตั้งค่า"',
} as const

export function settingsCard(p: { liffId: string; groupId: string }): LineMessage {
  const open = uri(SETTINGS_CARD_TEXT.button, liffUrl(p.liffId, 'settings', p.groupId))
  return {
    type: 'flex',
    altText: SETTINGS_CARD_TEXT.altText,
    contents: bubble(
      [header('info', SETTINGS_CARD_TEXT.title), text(SETTINGS_CARD_TEXT.body, { color: '#545454' })],
      [button('primary', open), caption(SETTINGS_CARD_TEXT.footnote, { size: 'xxs', align: 'center' })],
    ),
  }
}

/** Best effort: a failed reply is logged; the person can type the command again. */
export async function replySettingsCard(deps: Deps, p: { groupId: string; replyToken: string }): Promise<void> {
  try {
    await deps.line.reply(p.replyToken, [settingsCard({ liffId: deps.config.liffId, groupId: p.groupId })])
    log('settings_card_replied', { groupId: p.groupId })
  } catch (err) {
    logError('settings_card_failed', { groupId: p.groupId }, err)
  }
}
