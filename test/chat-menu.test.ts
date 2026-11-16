import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHAT_MENU_MAX_GROUPS, CHAT_MENU_TEXT, parseChatMenu } from '@/server/chat/menu'
import { CONNECT_TEXT } from '@/server/google/connect-card'
import { liffUrl } from '@/server/liff-links'
import type { LineEvent } from '@/server/line/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { TEST_LIFF_ID, TEST_NOW, ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #84: the 1:1 chat answers its Rich Menu words (and the same typed words) through the
// webhook seam. Every answer is one reply, never a push.

const ME = 'Uuser1'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const reply = () => JSON.stringify(h.line.replies.at(-1)?.messages)
  const group = (lineGroupId: string, name: string, owner: string) => {
    const g = seedOwnedGroup(h.store, { lineGroupId, owner })
    h.store.tables.groups.find((r) => r.id === g.id)!.name = name
    return g
  }
  return { ...h, send, reply, group }
}

describe('1:1 chat menu (#84)', () => {
  it.each(['Dashboard', 'งานของฉัน', 'dashboard ครับ'])('%j answers with a Dashboard card, as one reply', async (word) => {
    const t = setup()
    await t.send(ev.userText({ text: word }))
    expect(t.line.replies).toHaveLength(1)
    expect(t.reply()).toContain(JSON.stringify(liffUrl(TEST_LIFF_ID, 'dashboard')))
    expect(t.line.pushes).toHaveLength(0)
  })

  it('"ตั้งค่า" lists my groups, the ones I own first and marked, each with a button to its Settings', async () => {
    const t = setup()
    const member = t.group('Cb', 'ทีมออกแบบ', 'Uother')
    t.store.seedMember({ groupId: member.id, lineUserId: ME, displayName: 'ฉัน' })
    const owned = t.group('Ca', 'โปรเจกต์หลัก', ME)
    await t.send(ev.userText({ text: 'ตั้งค่า' }))
    const body = t.reply()
    expect(body).toContain(CHAT_MENU_TEXT.settingsTitle)
    expect(body).toContain(JSON.stringify(liffUrl(TEST_LIFF_ID, 'settings', owned.id)))
    expect(body).toContain(JSON.stringify(liffUrl(TEST_LIFF_ID, 'settings', member.id)))
    // The owned group comes first and carries the Owner pill; the other says Member.
    expect(body.indexOf('โปรเจกต์หลัก')).toBeLessThan(body.indexOf('ทีมออกแบบ'))
    // One Owner pill (the pill is the only xxs text that says it).
    expect(body.split(`"text":"${CHAT_MENU_TEXT.owner}","size":"xxs"`)).toHaveLength(2)
    expect(body).toContain(CHAT_MENU_TEXT.member)
    expect(t.line.pushes).toHaveLength(0)
  })

  it('does not list a group I left, or a group the bot left', async () => {
    const t = setup()
    const left = t.group('Cl', 'กลุ่มที่ออกแล้ว', 'Uother')
    t.store.seedMember({ groupId: left.id, lineUserId: ME, displayName: 'ฉัน', leftAt: TEST_NOW })
    const botGone = t.group('Cg', 'บอทออกแล้ว', ME)
    t.store.seedSchedule(botGone.id, { leftAt: TEST_NOW })
    t.group('Ck', 'กลุ่มที่ยังอยู่', ME)
    await t.send(ev.userText({ text: 'ตั้งค่า' }))
    const body = t.reply()
    expect(body).toContain('กลุ่มที่ยังอยู่')
    expect(body).not.toContain('กลุ่มที่ออกแล้ว')
    expect(body).not.toContain('บอทออกแล้ว')
  })

  it('"ตั้งค่า" with no group says how to start', async () => {
    const t = setup()
    await t.send(ev.userText({ text: 'ตั้งค่า' }))
    expect(t.reply()).toContain(CHAT_MENU_TEXT.noGroups)
  })

  it('lists at most CHAT_MENU_MAX_GROUPS groups and counts the rest', async () => {
    const t = setup()
    for (let i = 0; i < CHAT_MENU_MAX_GROUPS + 2; i++) t.group(`C${i}`, `กลุ่ม ${i}`, ME)
    await t.send(ev.userText({ text: 'ตั้งค่า' }))
    expect(t.reply()).toContain(JSON.stringify(CHAT_MENU_TEXT.more(2)).slice(1, -1))
  })

  it.each(['เชื่อมต่อ Google Drive', 'สวัสดี', 'ตั้งค่ากลุ่มยังไง'])('%j still answers with the Google Drive card', async (word) => {
    const t = setup()
    await t.send(ev.userText({ text: word }))
    expect(t.line.replies).toHaveLength(1)
    expect(t.reply()).toContain(CONNECT_TEXT.connect)
  })

  it('a follow still gets the Google Drive card', async () => {
    const t = setup()
    await t.send(ev.follow({}))
    expect(t.reply()).toContain(CONNECT_TEXT.connect)
  })
})

describe('parseChatMenu (#84)', () => {
  it.each([
    ['Dashboard', 'dashboard'], ['งานของฉัน', 'dashboard'], ['งานของฉันหน่อย', 'dashboard'],
    ['ตั้งค่า', 'settings'], ['การตั้งค่า', 'settings'], ['Settings', 'settings'], ['ตั้งค่าครับ!', 'settings'],
    ['เชื่อมต่อ Google Drive', 'drive'], ['google drive', 'drive'],
  ])('%j is %s', (text, menu) => {
    expect(parseChatMenu(text)).toBe(menu)
  })
  it.each(['ตั้งค่ากลุ่มยังไง', 'ดูงานหน่อย', 'สวัสดี', '', null])('%j is no menu word', (text) => {
    expect(parseChatMenu(text)).toBeNull()
  })
})
