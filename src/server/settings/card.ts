import { log, logError } from '../log'
import type { LineMessage, LineUriAction } from '../line/types'
import { liffUrl } from '../liff-links'
import type { Deps } from '../ports'

// #28: the answer to "NongJoDII ตั้งค่า" in a group. A reply (never a push, so no quota)
// with one button that opens Settings for that group. Anyone may ask; the page itself lets
// only the confirmed Owner change values. Same look as the setup card (setup/card.ts).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD' } as const

export const SETTINGS_CARD_TEXT = {
  title: 'การตั้งค่ากลุ่ม ⚙️',
  body: 'ดูและแก้สิ่งที่ตั้งไว้ตอนเริ่มใช้: เรื่องที่กลุ่มทำ ชื่อเล่นและหน้าที่ ฟีเจอร์ และเวลาเตือน',
  button: 'เปิดการตั้งค่า',
  footnote: 'เจ้าของบอทแก้ได้ สมาชิกคนอื่นดูได้อย่างเดียว',
  altText: 'การตั้งค่ากลุ่ม: แตะ "เปิดการตั้งค่า"',
} as const

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

export function settingsCard(p: { liffId: string; groupId: string }): LineMessage {
  const open: LineUriAction = { type: 'uri', label: SETTINGS_CARD_TEXT.button, uri: liffUrl(p.liffId, 'settings', p.groupId) }
  return {
    type: 'flex',
    altText: SETTINGS_CARD_TEXT.altText,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [text(SETTINGS_CARD_TEXT.title, { weight: 'bold', size: 'md' }), text(SETTINGS_CARD_TEXT.body)],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [
          { type: 'button', style: 'primary', color: C.primary, height: 'sm', action: open },
          text(SETTINGS_CARD_TEXT.footnote, { size: 'xxs', color: C.muted, align: 'center' }),
        ],
      },
    },
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
