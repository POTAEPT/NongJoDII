import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GUIDE_COMMANDS, GUIDE_COMMAND_ORDER } from '@/app/guide/commands'
import Guide from '@/app/guide/page'
import Home from '@/app/page'
import { guideUrl, HELP_TEXT } from '@/server/commands/help'
import { parseGroupCommand, type GroupCommand } from '@/server/commands/parse'
import { COMMAND_TEXT } from '@/server/commands/quick-reply'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { buttonActions } from './flex-text'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, TEST_APP_BASE_URL, webhookBody } from './harness'

// #133: the /guide how-to page. Its command table must match what parse.ts reads, and the
// homepage, the footer and the help card link to it.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const page = () => renderToStaticMarkup(Guide())
/** Text without tags, so a command split by markup still matches. */
const pageText = () => page().replace(/<[^>]+>/g, '').replace(/&quot;/g, '"')

describe('the command table', () => {
  const keys = Object.keys(GUIDE_COMMANDS) as GroupCommand[]

  it('lists every command once, in the table order', () => {
    expect([...GUIDE_COMMAND_ORDER].sort()).toEqual([...keys].sort())
    expect(new Set(GUIDE_COMMAND_ORDER).size).toBe(GUIDE_COMMAND_ORDER.length)
  })

  it.each(keys)('%s: every way to type it really parses to that command', (key) => {
    const c = GUIDE_COMMANDS[key]
    for (const text of [c.text, ...(c.also ?? [])]) expect(parseGroupCommand(text), text).toBe(key)
  })

  it('covers every command the quick reply buttons and the help card send', () => {
    const listed = new Set(keys.flatMap((k) => [GUIDE_COMMANDS[k].text, ...(GUIDE_COMMANDS[k].also ?? [])]))
    for (const text of Object.values(COMMAND_TEXT)) expect(listed.has(text), text).toBe(true)
  })

  it('is on the page', () => {
    const t = pageText()
    for (const key of keys) {
      expect(t).toContain(GUIDE_COMMANDS[key].text)
      expect(t).toContain(GUIDE_COMMANDS[key].answer)
    }
  })
})

describe('the page', () => {
  it('has the eight sections, each in the table of contents', () => {
    const html = page()
    for (const id of ['start', 'commands', 'summary', 'progress', 'reminders', 'files', 'dashboard', 'faq']) {
      expect(html).toContain(`id="${id}"`)
      expect(html).toContain(`href="#${id}"`)
    }
  })

  it('uses the card wording (#130)', () => {
    const t = pageText()
    for (const s of ['เจ้าของบอท', 'ผู้รับ', 'เสร็จ', 'กำลังทำ', 'ยังไม่มีผู้รับ', 'ใช่ เสร็จแล้ว', 'เลือกงานอื่น', 'ไม่ใช่การอัปเดตงาน', 'ขอเลื่อน', 'ฉันรับเอง']) {
      expect(t).toContain(s)
    }
  })

  it('is linked from the homepage and the shared footer', () => {
    const home = renderToStaticMarkup(Home())
    expect(home.match(/href="\/guide"/g)?.length).toBeGreaterThanOrEqual(2)
    expect(page()).toContain('href="/guide"')
  })
})

describe('the help card', () => {
  it('has a button that opens /guide on the app domain, with no IDs', async () => {
    const h = makeTestDeps()
    seedOwnedGroup(h.store)
    const res = await handleWebhookRequest(signedRequest(webhookBody(ev.groupText({ text: 'น้องจดดี วิธีใช้' }))), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
    const card = h.line.replies.at(-1)!.messages[0]
    const link = buttonActions(card).find((a) => a.label === HELP_TEXT.guideButton)
    expect(link).toMatchObject({ type: 'uri', uri: `${TEST_APP_BASE_URL}/guide` })
    expect(guideUrl(TEST_APP_BASE_URL)).toBe('https://nongjodii.test/guide')
    expect(h.line.pushes).toHaveLength(0)
  })
})
