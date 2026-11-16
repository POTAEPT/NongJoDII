import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseGroupCommand } from '@/server/commands/parse'
import { commandQuickReply, quickReply } from '@/server/commands/quick-reply'
import { filePausedCard } from '@/server/files/card'
import { loginCard } from '@/server/line/login-card'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { liffUrl } from '@/server/liff-links'
import { PICK_CANCEL_DATA } from '@/server/reminders/postback'
import { summaryFailedCard } from '@/server/summary/failure'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { buttonActions, messageText } from './flex-text'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_LIFF_ID, webhookBody } from './harness'

// The UX review changes (2026-11-16) that are not covered by the feature tests: the help
// command (1.3), the quick replies (1.2), the next-step cards (2.1, 2.2), the failure card
// (3.1, 3.3) and the picker's cancel (6.1).

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: [{ lineUserId: 'Ubiw', displayName: 'บิว' }] })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const last = (): LineMessage => h.line.replies[h.line.replies.length - 1].messages[0]
  return { ...h, group, send, last }
}

describe('help command (1.3)', () => {
  it.each(['น้องจดดี วิธีใช้', 'NongJoDII help', 'น้องจดดี ช่วยด้วยครับ', '@น้องจดดี', 'น้องจดดี', 'น้องจดดี!'])('reads %j as help', (text) => {
    expect(parseGroupCommand(text)).toBe('help')
  })

  it.each(['น้องจดดีน่ารักมาก', 'ขอบคุณน้องจดดี', 'วิธีใช้'])('leaves ordinary chat %j alone', (text) => {
    expect(parseGroupCommand(text)).toBeNull()
  })

  it('replies with the commands and the quick reply, with no AI call and no push', async () => {
    const t = setup()
    await t.send(ev.groupText({ text: 'น้องจดดี วิธีใช้', userId: 'Ubiw' }))
    const card = t.last()
    for (const s of ['น้องจดดีทำอะไรได้บ้าง', 'น้องจดดี สรุป', 'น้องจดดี ตั้งค่า', 'น้องจดดี done', 'น้องจดดี ขอไฟล์']) {
      expect(messageText(card)).toContain(s)
    }
    expect(card.type === 'flex' && card.quickReply).toEqual(commandQuickReply())
    expect(t.llm.requests).toHaveLength(0)
    expect(t.line.pushes).toHaveLength(0)
  })
})

describe('quick replies (1.2)', () => {
  it('send the commands the parser reads, with no Dashboard button, labels within LINE\'s 20 characters', () => {
    const items = quickReply('summarize', 'retrySummary', 'settings', 'help').items
    for (const i of items) {
      expect(parseGroupCommand(i.action.text)).not.toBeNull()
      expect([...i.action.label].length).toBeLessThanOrEqual(20)
    }
    expect(commandQuickReply().items.map((i) => i.action.text)).toEqual(['น้องจดดี สรุป', 'น้องจดดี ตั้งค่า', 'น้องจดดี วิธีใช้'])
    expect(JSON.stringify(commandQuickReply())).not.toContain('Dashboard')
  })
})

describe('next-step cards (2.1, 2.2)', () => {
  it('a turned-off Summary answers with a card that opens Settings', async () => {
    const t = setup()
    t.store.tables.groups[0].featureSummarize = false
    await t.send(ev.groupText({ text: 'น้องจดดี สรุป', userId: 'Ubiw' }))
    const card = t.last()
    expect(card.type).toBe('flex')
    expect(buttonActions(card.type === 'flex' ? card.contents : null).map((a) => a.uri)).toEqual([liffUrl(TEST_LIFF_ID, 'settings', t.group.id)])
    expect(t.llm.requests).toHaveLength(0)
  })

  it('a paused file save points at the step that fixes it', () => {
    const uriOf = (m: LineMessage) => buttonActions(m.type === 'flex' ? m.contents : null)[0].uri
    expect(uriOf(filePausedCard({ reason: 'no_owner', liffId: 'L', groupId: 'G' }))).toBe(liffUrl('L', 'setup', 'G'))
    expect(uriOf(filePausedCard({ reason: 'owner_left', liffId: 'L', groupId: 'G' }))).toBe(liffUrl('L', 'owner', 'G'))
    expect(uriOf(filePausedCard({ reason: 'no_drive', liffId: 'L', groupId: 'G' }))).toBe(liffUrl('L', 'google'))
  })

  it('no LINE template is left: the login prompt is a Flex card too', () => {
    expect(loginCard('L', 'a=pg').type).toBe('flex')
  })
})

describe('the Summary failure card (3.1, 3.3)', () => {
  const at = new Date('2026-11-16T03:00:00Z')

  it('speaks plainly, keeps the code small, and offers to try again', () => {
    const card = summaryFailedCard('ai_output', at)
    const words = messageText(card)
    expect(words).toContain('สรุปไม่สำเร็จ')
    expect(words).toContain('รหัสสำหรับแจ้งทีม: SUM-AI-FORMAT · 10:00')
    for (const s of ['AI ตอบกลับ', 'รูปแบบที่อ่านไม่ได้']) expect(words).not.toContain(s)
    expect(card.type === 'flex' && card.quickReply?.items[0].action.text).toBe('น้องจดดี สรุป')
  })

  it('offers no retry when trying again cannot help', () => {
    const card = summaryFailedCard('ai_credits', at)
    expect(card.type === 'flex' && card.quickReply).toBeUndefined()
  })
})

describe('the picker\'s cancel (6.1)', () => {
  it('answers "ยกเลิก" and changes nothing', async () => {
    const t = setup()
    const task = t.store.seedTask({ groupId: t.group.id, title: 'ทำสไลด์', createdByLineUserId: 'Ubiw', status: 'in_process', assigneeLineUserId: 'Ubiw' })
    await t.send(ev.groupPostback({ data: PICK_CANCEL_DATA, userId: 'Ubiw' }))
    expect(t.last()).toEqual({ type: 'text', text: 'โอเค ไม่ได้เปลี่ยนอะไร' })
    expect(t.store.tables.tasks.find((x) => x.id === task.id)?.status).toBe('in_process')
  })
})
