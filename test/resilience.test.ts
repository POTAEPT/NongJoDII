import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

const ANSWER = JSON.stringify({ summary: 'สรุป', tasks: [] })

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function setup() {
  const h = makeTestDeps()
  seedOwnedGroup(h.store, { lineGroupId: 'Cga' })
  h.llm.respond({ content: ANSWER, model: TEXT_MODEL, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 } })
  const send = async (text: string) => {
    const res = await handleWebhookRequest(
      signedRequest(webhookBody(ev.groupText({ text, groupId: 'Cga', userId: 'Uuser1', timestamp: h.deps.now().getTime() }))),
      h.deps, h.defer,
    )
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  await send('งานเยอะมาก')
  h.line.replies.length = 0
  return { ...h, send }
}

const replyText = (m: { type: string; text?: string } | undefined) => (m?.type === 'text' ? m.text : '')

describe('Webhook resilience', () => {
  it('a LINE name refresh failure does not stop the Summary', async () => {
    const t = await setup()
    t.line.failProfile = true
    await t.send('NongJoDII summarize')
    expect(t.line.profileCalls.length).toBeGreaterThan(0)
    expect(t.line.replies).toHaveLength(1)
    expect(replyText(t.line.replies[0].messages[0])).toContain('สรุป')
  })

  it('a store failure at createSummary replies with the failure notice', async () => {
    const t = await setup()
    t.store.failNext('createSummary')
    await t.send('NongJoDII summarize')
    expect(t.line.replies).toHaveLength(1)
    expect(replyText(t.line.replies[0].messages[0])).toContain('ไม่สำเร็จ')
  })

  it('a store failure in the fair-use pre-check replies with the failure notice', async () => {
    const t = await setup()
    t.store.failNext('sumOwnerMonthUsage')
    await t.send('NongJoDII summarize')
    expect(t.line.replies).toHaveLength(1)
    expect(replyText(t.line.replies[0].messages[0])).toContain('ไม่สำเร็จ')
    expect(t.llm.requests).toHaveLength(0)
  })
})
