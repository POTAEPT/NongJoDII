import { sendConnectDriveCard } from '../google/connect-card'
import { COLOR, bubble, button, caption, column, header, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log, logError } from '../log'
import type { Deps, UserGroup } from '../ports'

// #84: the 1:1 chat with the OA. Its Rich Menu buttons send text ("Dashboard", "งานของฉัน",
// "ตั้งค่า", "เชื่อมต่อ Google Drive"), and people may type the same words. Each answer is a
// reply (free), never a push:
//   Dashboard / งานของฉัน  a card with a button to the LIFF Dashboard (no group needed: it
//                          shows every group the person is in, by their role).
//   ตั้งค่า               the groups the person is in, each with a button to that group's
//                          Settings, the ones they own marked "เจ้าของบอท". Settings needs a
//                          group, so it cannot open from 1:1 directly.
//   anything else         the Google Drive card, as before (#12, #14).

export type ChatMenu = 'dashboard' | 'settings' | 'drive'

/** Polite words and punctuation people add, as for the group commands. */
const TAIL = '(?:\\s*(?:ให้|หน่อย|ด้วย|ครับ|คับ|ค่ะ|คะ|ค่า|นะ|จ้า|please))*\\s*[!.?~ๆ]*'
const DASHBOARD = new RegExp(`^(?:dashboard|แดชบอร์ด|ดู ?dashboard|งานของฉัน|my tasks)${TAIL}$`, 'i')
const SETTINGS = new RegExp(`^(?:ตั้งค่า|การตั้งค่า|settings?)${TAIL}$`, 'i')
const DRIVE = new RegExp(`^(?:เชื่อมต่อ ?google ?drive|เชื่อม ?google ?drive|google ?drive|drive)${TAIL}$`, 'i')

export function parseChatMenu(raw: string | null): ChatMenu | null {
  if (!raw) return null
  const t = raw.trim().replace(/\s+/g, ' ')
  if (DASHBOARD.test(t)) return 'dashboard'
  if (SETTINGS.test(t)) return 'settings'
  if (DRIVE.test(t)) return 'drive'
  return null
}

export const CHAT_MENU_TEXT = {
  dashboardTitle: 'Dashboard',
  dashboardBody: 'ดูงานของทุกกลุ่มที่คุณอยู่ เจ้าของบอทเห็นภาพรวมของกลุ่ม',
  dashboardButton: 'เปิด Dashboard',
  settingsTitle: 'เลือกกลุ่มที่จะตั้งค่า',
  settingsBody: 'เจ้าของบอทแก้การตั้งค่าได้ สมาชิกคนอื่นดูได้อย่างเดียว',
  settingsButton: 'ตั้งค่า',
  owner: 'เจ้าของบอท',
  member: 'สมาชิก',
  unnamed: 'กลุ่มที่ไม่มีชื่อ',
  more: (n: number) => `และอีก ${n} กลุ่ม พิมพ์ "น้องจดดี ตั้งค่า" ในกลุ่มนั้นได้เลย`,
  noGroups: 'คุณยังไม่ได้อยู่ในกลุ่มที่มีน้องจดดี เชิญน้องจดดีเข้ากลุ่ม LINE ที่ใช้คุยงานก่อนนะ',
} as const

/** Groups one card lists; the rest are counted in one line (a bubble has a size limit). */
export const CHAT_MENU_MAX_GROUPS = 8

export function dashboardCard(liffId: string): LineMessage {
  return {
    type: 'flex',
    altText: `${CHAT_MENU_TEXT.dashboardTitle}: ${CHAT_MENU_TEXT.dashboardButton}`,
    contents: bubble(
      [header('info', CHAT_MENU_TEXT.dashboardTitle), text(CHAT_MENU_TEXT.dashboardBody, { color: COLOR.ink2 })],
      [button('primary', uri(CHAT_MENU_TEXT.dashboardButton, liffUrl(liffId, 'dashboard')))],
    ),
  }
}

/** Owned groups first, then by name. */
export function sortGroups(groups: UserGroup[]): UserGroup[] {
  return [...groups].sort((a, b) =>
    Number(b.isOwner) - Number(a.isOwner) || (a.name ?? '').localeCompare(b.name ?? '', 'th') || a.groupId.localeCompare(b.groupId))
}

function ownerPill(): Record<string, unknown> {
  return {
    type: 'box', layout: 'vertical', flex: 0, backgroundColor: COLOR.primarySoft, cornerRadius: 'xxl',
    paddingStart: 'sm', paddingEnd: 'sm', paddingTop: '2px', paddingBottom: '2px',
    contents: [{ type: 'text', text: CHAT_MENU_TEXT.owner, size: 'xxs', weight: 'bold', color: COLOR.primary }],
  }
}

/** One row: the group's name (with the Owner pill when the person owns it) and a button to
 *  its Settings. */
function groupRow(liffId: string, g: UserGroup): Record<string, unknown> {
  const name = text(g.name ?? CHAT_MENU_TEXT.unnamed, { weight: 'bold', flex: 0 })
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center',
    contents: [
      column(
        g.isOwner
          ? [{ type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [name, ownerPill()] }]
          : [name, caption(CHAT_MENU_TEXT.member)],
        { flex: 1, spacing: 'xs' },
      ),
      button('secondary', uri(CHAT_MENU_TEXT.settingsButton, liffUrl(liffId, 'settings', g.groupId)), { flex: 0 }),
    ],
  }
}

export function settingsGroupsCard(liffId: string, groups: UserGroup[]): LineMessage {
  const sorted = sortGroups(groups)
  const shown = sorted.slice(0, CHAT_MENU_MAX_GROUPS)
  const rest = sorted.length - shown.length
  const owned = sorted.filter((g) => g.isOwner).map((g) => g.name ?? CHAT_MENU_TEXT.unnamed)
  return {
    type: 'flex',
    altText: owned.length > 0
      ? `${CHAT_MENU_TEXT.settingsTitle} (${CHAT_MENU_TEXT.owner}: ${owned.join(', ')})`.slice(0, 400)
      : CHAT_MENU_TEXT.settingsTitle,
    contents: bubble([
      header('info', CHAT_MENU_TEXT.settingsTitle),
      caption(CHAT_MENU_TEXT.settingsBody),
      column(shown.map((g) => groupRow(liffId, g)), { spacing: 'md' }),
      ...(rest > 0 ? [caption(CHAT_MENU_TEXT.more(rest))] : []),
    ]),
  }
}

/** The user_chat Job (a 1:1 follow or message). */
export async function handleUserChat(
  deps: Deps,
  job: { lineUserId: string; replyToken: string | null; text: string | null },
): Promise<void> {
  const menu = parseChatMenu(job.text)
  if (!job.replyToken || menu === null || menu === 'drive') {
    await sendConnectDriveCard(deps, job)
    return
  }
  try {
    if (menu === 'dashboard') {
      await deps.line.reply(job.replyToken, [dashboardCard(deps.config.liffId)])
    } else {
      const groups = await deps.store.listUserGroups(job.lineUserId)
      await deps.line.reply(job.replyToken, [
        groups.length === 0
          ? { type: 'text', text: CHAT_MENU_TEXT.noGroups }
          : settingsGroupsCard(deps.config.liffId, groups),
      ])
    }
    log('chat_menu_replied', { menu })
  } catch (err) {
    logError('chat_menu_failed', { menu }, err)
  }
}
