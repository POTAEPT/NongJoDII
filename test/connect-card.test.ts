import { describe, expect, it, vi } from 'vitest'
import { liffUrl } from '@/server/liff-links'
import type { LineMessage } from '@/server/line/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, TEST_LIFF_ID, TEST_NOW, webhookBody } from './harness'

const OWNER = 'Uowner1'

function setup() {
  const h = makeTestDeps()
  const send = async (...events: Parameters<typeof webhookBody>) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    await h.runDeferred()
    return res
  }
  return { ...h, send }
}

function card(m: LineMessage) {
  if (m.type !== 'template') throw new Error('not a template')
  return m.template
}

describe('connect card', () => {
  it('1. a follow gets the buttons card to the LIFF google view, and no messages row', async () => {
    const { send, line, store } = setup()
    await send(ev.follow({ userId: OWNER, eventId: 'f1' }))
    expect(line.replies).toHaveLength(1)
    const [m] = line.replies[0].messages
    expect(line.replies[0].messages).toHaveLength(1)
    expect(m.type).toBe('template')
    expect(card(m).actions).toEqual([
      { type: 'uri', label: 'เชื่อม Google Drive', uri: 'https://liff.line.me/2000000000-abcdefgh?view=google' },
    ])
    expect(store.tables.messages).toHaveLength(0)
  })

  it('2. a 1:1 text gets the same card', async () => {
    const { send, line } = setup()
    await send(ev.userText({ userId: OWNER, text: 'สวัสดี' }))
    expect(line.replies).toHaveLength(1)
    expect(line.replies[0].messages[0].type).toBe('template')
  })

  it('2b. a failing account lookup still sends the card', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { send, line, store } = setup()
    store.failNext('findGoogleAccountByLineUser')
    await send(ev.follow({ userId: OWNER, eventId: 'f2b' }))
    expect(line.replies).toHaveLength(1)
    expect(line.replies[0].messages[0].type).toBe('template')
    vi.restoreAllMocks()
  })

  it('3. a connected Owner gets the already-connected text', async () => {
    const { send, line, store } = setup()
    await store.upsertLineUser({ lineUserId: OWNER, displayName: null })
    await store.upsertGoogleAccount({
      lineUserId: OWNER, googleSubject: 'g1', email: null, grantedScopes: [], refreshTokenCiphertext: 'v1.x',
      signedInAt: TEST_NOW,
    })
    await send(ev.follow({ userId: OWNER }))
    expect(line.replies[0].messages).toEqual([
      { type: 'text', text: 'เชื่อม Google Drive ไว้แล้ว น้องจดดีจะเก็บไฟล์ของกลุ่มลงไดรฟ์ของคุณ' },
    ])
  })

  it('3b. a revoked account still gets the card', async () => {
    const { send, line, store } = setup()
    await store.upsertLineUser({ lineUserId: OWNER, displayName: null })
    await store.upsertGoogleAccount({
      lineUserId: OWNER, googleSubject: 'g1', email: null, grantedScopes: [], refreshTokenCiphertext: 'v1.x',
      signedInAt: TEST_NOW,
    })
    store.tables.google_accounts[0].tokenStatus = 'revoked'
    await send(ev.follow({ userId: OWNER }))
    expect(line.replies[0].messages[0].type).toBe('template')
  })

  it('4. a redelivered follow (same event id) gets one reply in total', async () => {
    const { send, line } = setup()
    await send(ev.follow({ userId: OWNER, eventId: 'same' }))
    await send(ev.follow({ userId: OWNER, eventId: 'same' }))
    expect(line.replies).toHaveLength(1)
  })

  it('4b. a redelivered 1:1 text gets one reply in total', async () => {
    const { send, line } = setup()
    const e = ev.userText({ userId: OWNER, text: 'hi', eventId: 'same-m' })
    await send(e)
    await send(e)
    expect(line.replies).toHaveLength(1)
  })

  it('4c. an event without a reply token sends nothing', async () => {
    const { send, line } = setup()
    const e = ev.follow({ userId: OWNER })
    delete e.replyToken
    await send(e)
    expect(line.replies).toHaveLength(0)
  })

  it('5. card text is at most 160 chars and the label at most 20', async () => {
    const { send, line } = setup()
    await send(ev.follow({ userId: OWNER }))
    const t = card(line.replies[0].messages[0])
    expect([...t.text].length).toBeLessThanOrEqual(160)
    expect([...t.actions[0].label].length).toBeLessThanOrEqual(20)
  })

  it('6. liffUrl builds view and encoded id', () => {
    expect(liffUrl(TEST_LIFF_ID, 'review', 'abc')).toBe(`https://liff.line.me/${TEST_LIFF_ID}?view=review&id=abc`)
    expect(liffUrl(TEST_LIFF_ID, 'task', 'a b')).toContain('&id=a%20b')
  })
})
