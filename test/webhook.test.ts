import { describe, expect, it } from 'vitest'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, webhookBody } from './harness'

function setup() {
  const h = makeTestDeps()
  const send = (body: string, opts?: Parameters<typeof signedRequest>[1]) =>
    handleWebhookRequest(signedRequest(body, opts), h.deps, h.defer)
  return { ...h, send }
}

describe('webhook', () => {
  it('1. rejects an invalid signature and stores nothing', async () => {
    const { send, store, deferred } = setup()
    const res = await send(webhookBody(ev.groupText({ text: 'hi' })), { signature: 'AAAA' })
    expect(res.status).toBe(401)
    expect(store.tables.webhook_events).toHaveLength(0)
    expect(store.tables.messages).toHaveLength(0)
    expect(store.tables.groups).toHaveLength(0)
    expect(store.tables.line_users).toHaveLength(0)
    expect(deferred).toHaveLength(0)
  })

  it('2. rejects a missing signature header the same way', async () => {
    const { send, store, deferred } = setup()
    const res = await send(webhookBody(ev.groupText({ text: 'hi' })), { signature: null })
    expect(res.status).toBe(401)
    expect(store.tables.webhook_events).toHaveLength(0)
    expect(store.tables.messages).toHaveLength(0)
    expect(store.tables.groups).toHaveLength(0)
    expect(store.tables.line_users).toHaveLength(0)
    expect(deferred).toHaveLength(0)
  })

  it('3. stores a valid group text', async () => {
    const { send, store } = setup()
    const timestamp = Date.UTC(2026, 10, 12, 4, 0, 0)
    const res = await send(webhookBody(ev.groupText({ text: 'สวัสดี', messageId: 'm-1', userId: 'Uuser1', timestamp })))
    expect(res.status).toBe(200)
    expect(store.tables.messages).toHaveLength(1)
    expect(store.tables.messages[0]).toMatchObject({
      lineMessageId: 'm-1', text: 'สวัสดี', senderLineUserId: 'Uuser1', messageType: 'text', sentAt: new Date(timestamp),
    })
    expect(store.tables.groups).toHaveLength(1)
    expect(store.tables.groups[0].lineGroupId).toBe('Cgroup1')
    expect(store.tables.group_members).toHaveLength(1)
    expect(store.tables.group_members[0]).toMatchObject({ lineUserId: 'Uuser1', source: 'message' })
  })

  it('4. the same event twice stores one message and defers one job', async () => {
    const { send, store, deferred } = setup()
    const first = ev.groupText({ text: 'hi', eventId: 'ev-dup', messageId: 'm-dup' })
    const second = ev.groupText({ text: 'hi', eventId: 'ev-dup', messageId: 'm-dup', redelivery: true })
    expect((await send(webhookBody(first))).status).toBe(200)
    expect((await send(webhookBody(second))).status).toBe(200)
    expect(store.tables.messages).toHaveLength(1)
    expect(store.tables.webhook_events).toHaveLength(1)
    expect(deferred).toHaveLength(1)
  })

  it('5. responds 200 before the profile lookup runs', async () => {
    const { send, store, line, deferred, runDeferred } = setup()
    line.profiles.set('Cgroup1:Uuser1', 'สมชาย')
    const res = await send(webhookBody(ev.groupText({ text: 'hi', userId: 'Uuser1' })))
    expect(res.status).toBe(200)
    expect(line.profileCalls).toHaveLength(0)
    expect(deferred).toHaveLength(1)
    await runDeferred()
    expect(line.profileCalls).toHaveLength(1)
    expect((await store.findLineUser('Uuser1'))?.displayName).toBe('สมชาย')
  })

  it('6. stores imageSet fields, and nulls without one', async () => {
    const { send, store } = setup()
    await send(webhookBody(ev.groupImage({ messageId: 'img-1', imageSet: { id: 'set-1', index: 2, total: 3 } })))
    await send(webhookBody(ev.groupImage({ messageId: 'img-2' })))
    const [withSet, without] = store.tables.messages
    expect(withSet).toMatchObject({
      messageType: 'image', imageSetId: 'set-1', imageSetIndex: 2, imageSetTotal: 3, text: null, lineMessageId: 'img-1',
    })
    expect(without).toMatchObject({ imageSetId: null, imageSetIndex: null, imageSetTotal: null, text: null })
  })

  it('6b. stores each mention with the tagged userId, and null without a tag', async () => {
    const { send, store } = setup()
    await send(webhookBody(
      ev.groupText({
        text: '@Pim @All ดูด้วย', messageId: 'm-tag',
        mentionees: [
          { index: 0, length: 4, type: 'user', userId: 'Upim', isSelf: false },
          { index: 5, length: 4, type: 'all' },
          { index: 0, length: 4, type: 'user' }, // no profile consent: LINE leaves userId out
        ],
      }),
      ev.groupText({ text: 'ไม่มีแท็ก', messageId: 'm-plain' }),
    ))
    const tagged = store.tables.messages.find((m) => m.lineMessageId === 'm-tag')
    const plain = store.tables.messages.find((m) => m.lineMessageId === 'm-plain')
    expect(tagged?.mentions).toEqual([
      { index: 0, length: 4, type: 'user', userId: 'Upim' },
      { index: 5, length: 4, type: 'all', userId: null },
      { index: 0, length: 4, type: 'user', userId: null },
    ])
    expect(plain?.mentions).toBeNull()
  })

  it('6c. drops malformed mention entries', async () => {
    const { send, store } = setup()
    const event = ev.groupText({ text: '@Pim hi', messageId: 'm-bad' })
    ;(event.message as { mention?: unknown }).mention = {
      mentionees: [{ index: '0', length: 4, type: 'user', userId: 'U1' }, { index: 0, length: 4, type: 'group' }, null],
    }
    await send(webhookBody(event))
    expect(store.tables.messages[0].mentions).toBeNull()
  })

  it('7. empty events returns 200 and stores nothing', async () => {
    const { send, store, deferred } = setup()
    const res = await send(webhookBody())
    expect(res.status).toBe(200)
    expect(store.tables.webhook_events).toHaveLength(0)
    expect(store.tables.messages).toHaveLength(0)
    expect(deferred).toHaveLength(0)
  })

  // A join now answers with the setup card (#52, test/setup.test.ts).
  it('8. a leave event is only recorded', async () => {
    const { send, store, deferred } = setup()
    const leave = {
      type: 'leave', timestamp: Date.now(), source: { type: 'group' as const, groupId: 'Cgroup1' },
      webhookEventId: 'ev-leave', deliveryContext: { isRedelivery: false },
    }
    const res = await send(webhookBody(leave))
    expect(res.status).toBe(200)
    expect(store.tables.webhook_events).toHaveLength(1)
    expect(store.tables.webhook_events[0]).toMatchObject({ eventType: 'leave', lineGroupId: 'Cgroup1' })
    expect(store.tables.messages).toHaveLength(0)
    expect(deferred).toHaveLength(0)
  })

  it('9. a group text with no userId has a null sender and no member row', async () => {
    const { send, store, line, runDeferred } = setup()
    const res = await send(webhookBody(ev.groupText({ text: 'hi', userId: null })))
    expect(res.status).toBe(200)
    expect(store.tables.messages).toHaveLength(1)
    expect(store.tables.messages[0].senderLineUserId).toBeNull()
    expect(store.tables.group_members).toHaveLength(0)
    await runDeferred()
    expect(line.profileCalls).toHaveLength(0)
  })

  it('10. a store failure returns 500 and a resend recovers', async () => {
    const { send, store, deferred } = setup()
    const body = webhookBody(ev.groupText({ text: 'hi' }))
    store.failNext('insertMessage')
    expect((await send(body)).status).toBe(500)
    expect(deferred).toHaveLength(0)
    expect((await send(body)).status).toBe(200)
    expect(store.tables.messages).toHaveLength(1)
    expect(deferred).toHaveLength(1)
  })

  it('10b. a partial batch defers the stored job, and a resend only adds the rest', async () => {
    const { send, store, line, deferred, runDeferred } = setup()
    const body = webhookBody(
      ev.groupText({ text: 'A', userId: 'Ua' }),
      ev.groupText({ text: 'B', userId: 'Ub' }),
    )
    store.failNext('insertMessage', undefined, { after: 1 })
    expect((await send(body)).status).toBe(500)
    expect(deferred).toHaveLength(1)
    await runDeferred()
    expect(line.profileCalls).toEqual([{ lineGroupId: 'Cgroup1', lineUserId: 'Ua' }])
    expect((await send(body)).status).toBe(200)
    expect(store.tables.messages).toHaveLength(2)
    expect(deferred).toHaveLength(1)
    await runDeferred()
    expect(line.profileCalls.map((c) => c.lineUserId)).toEqual(['Ua', 'Ub'])
  })

  it('11. malformed JSON with a valid signature returns 400', async () => {
    const { send } = setup()
    expect((await send('{not json')).status).toBe(400)
    expect((await send('{"destination":"U"}')).status).toBe(400)
  })
})
