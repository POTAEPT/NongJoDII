import { log, logError } from '../log'
import type { LineMessage, LineUriAction } from '../line/types'
import { liffUrl } from '../liff-links'
import type { Deps } from '../ports'

// #29: the answer to a memberJoined event. A reply (never a push, so it costs no quota)
// with a short welcome and a button to the "my info" screen for nicknames and role.
// Same look as the setup card (setup/card.ts).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD' } as const

export const WELCOME_TEXT = {
  title: 'ยินดีต้อนรับเข้ากลุ่มนะ 👋',
  intro: 'น้องจดดีช่วยสรุปงานจากแชต ติดตามงาน และเตือนงานของกลุ่มนี้',
  ask: 'บอกชื่อเล่นและหน้าที่ของคุณหน่อย น้องจะได้รู้ว่าแชตพูดถึงใคร',
  button: 'ข้อมูลของฉัน',
  footnote: 'ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE',
  altText: 'ยินดีต้อนรับเข้ากลุ่มนะ 👋 แตะ "ข้อมูลของฉัน" เพื่อบอกชื่อเล่นและหน้าที่',
} as const

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

/** `groupId` is groups.id; the button opens the "my info" screen of that group. */
export function welcomeCard(p: { liffId: string; groupId: string }): LineMessage {
  const open: LineUriAction = { type: 'uri', label: WELCOME_TEXT.button, uri: liffUrl(p.liffId, 'me', p.groupId) }
  return {
    type: 'flex',
    altText: WELCOME_TEXT.altText,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          text(WELCOME_TEXT.title, { weight: 'bold', size: 'md' }),
          text(WELCOME_TEXT.intro),
          text(WELCOME_TEXT.ask),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md',
        contents: [
          { type: 'button', style: 'primary', color: C.primary, height: 'sm', action: open },
          text(WELCOME_TEXT.footnote, { size: 'xxs', color: C.muted, align: 'center' }),
        ],
      },
    },
  }
}

/** The memberJoined Job: the welcome reply and the joiners' LINE names. The two steps are
 *  independent, as in setup/join.ts: a slow name lookup never costs the reply token, and a
 *  failed reply still stores the names. A LINE error on one name leaves that name empty
 *  until the person's first message, button press or LIFF login. */
export async function handleMemberJoined(
  deps: Deps,
  job: { groupId: string; lineGroupId: string; lineUserIds: string[]; replyToken: string | null },
): Promise<void> {
  const { groupId, lineGroupId, lineUserIds, replyToken } = job
  await Promise.all([
    (async () => {
      if (!replyToken) return
      try {
        await deps.line.reply(replyToken, [welcomeCard({ liffId: deps.config.liffId, groupId })])
        log('member_welcome_replied', { groupId })
      } catch (err) {
        logError('member_welcome_failed', { groupId }, err)
      }
    })(),
    (async () => {
      for (const lineUserId of lineUserIds) {
        try {
          const profile = await deps.line.getGroupMemberProfile(lineGroupId, lineUserId)
          if (profile) await deps.store.upsertLineUser({ lineUserId, displayName: profile.displayName })
        } catch (err) {
          logError('line_name_refresh_failed', { lineGroupId }, err)
        }
      }
    })(),
  ])
}
