import { commandQuickReply } from '../commands/quick-reply'
import { log, logError } from '../log'
import { bubble, button, caption, header, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import type { Deps } from '../ports'

// #29: the answer to a memberJoined event. A reply (never a push, so it costs no quota)
// with a short welcome and a button to the "my info" screen for nicknames and role.
// Same look as the setup card (setup/card.ts).

export const WELCOME_TEXT = {
  title: 'ยินดีต้อนรับเข้ากลุ่มนะ',
  intro: 'น้องจดดีช่วยสรุปงานจากแชต ติดตามงาน และเตือนงานของกลุ่มนี้',
  ask: 'บอกชื่อเล่นและหน้าที่ของคุณหน่อย น้องจะได้รู้ว่าแชตพูดถึงใคร',
  button: 'ข้อมูลของฉัน',
  footnote: 'ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE',
  altText: 'ยินดีต้อนรับเข้ากลุ่มนะ แตะ "ข้อมูลของฉัน" เพื่อบอกชื่อเล่นและหน้าที่',
} as const

/** #83: a Member who left and was invited back. Their nicknames and role were kept (the
 *  membership row stays with left_at); the Tasks released when they left stay released. */
export const WELCOME_BACK_TEXT = {
  title: 'ยินดีต้อนรับกลับนะ',
  body: 'ชื่อเล่นและหน้าที่เดิมของคุณยังอยู่ แก้ได้ที่ปุ่มด้านล่าง',
  tasks: 'งานที่เคยรับไว้ถูกคืนให้กลุ่มตอนออกไปแล้ว ถ้าจะทำต่อ กดฉันรับเองที่การ์ดงานได้เลย',
  altText: 'ยินดีต้อนรับกลับนะ ชื่อเล่นและหน้าที่เดิมของคุณยังอยู่',
} as const

/** `groupId` is groups.id; the button opens the "my info" screen of that group. `returning`:
 *  every joiner had left this group before (#83), so the card welcomes them back. */
export function welcomeCard(p: { liffId: string; groupId: string; returning?: boolean }): LineMessage {
  const open = uri(WELCOME_TEXT.button, liffUrl(p.liffId, 'me', p.groupId))
  const footer = [button('primary', open), caption(WELCOME_TEXT.footnote, { size: 'xxs', align: 'center' })]
  if (p.returning) {
    return {
      type: 'flex',
      altText: WELCOME_BACK_TEXT.altText,
      quickReply: commandQuickReply(), // UX review 1.2
      contents: bubble(
        [
          header('info', WELCOME_BACK_TEXT.title),
          text(WELCOME_BACK_TEXT.body, { color: '#545454' }),
          text(WELCOME_BACK_TEXT.tasks, { color: '#545454' }),
        ],
        footer,
      ),
    }
  }
  return {
    type: 'flex',
    altText: WELCOME_TEXT.altText,
    quickReply: commandQuickReply(), // UX review 1.2
    contents: bubble(
      [
        header('info', WELCOME_TEXT.title),
        text(WELCOME_TEXT.intro, { color: '#545454' }),
        text(WELCOME_TEXT.ask, { color: '#545454' }),
      ],
      footer,
    ),
  }
}

/** The memberJoined Job: the welcome reply and the joiners' LINE names. The two steps are
 *  independent, as in setup/join.ts: a slow name lookup never costs the reply token, and a
 *  failed reply still stores the names. A LINE error on one name leaves that name empty
 *  until the person's first message, button press or LIFF login. */
export async function handleMemberJoined(
  deps: Deps,
  job: { groupId: string; lineGroupId: string; lineUserIds: string[]; replyToken: string | null; returning?: boolean },
): Promise<void> {
  const { groupId, lineGroupId, lineUserIds, replyToken, returning } = job
  await Promise.all([
    (async () => {
      if (!replyToken) return
      try {
        await deps.line.reply(replyToken, [welcomeCard({ liffId: deps.config.liffId, groupId, returning })])
        log('member_welcome_replied', { groupId, returning: returning === true })
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
