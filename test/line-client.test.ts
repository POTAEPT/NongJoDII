import { describe, expect, it } from 'vitest'
import { LineHttpClient } from '@/server/line/client'
import { AdapterError } from '@/server/log'

type Call = { url: string; init: RequestInit }

function stubFetch(status: number, body: unknown = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const client = new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl })
  return { client, calls }
}

function headersOf(call: Call): Headers {
  return new Headers(call.init.headers)
}

describe('LineHttpClient.reply', () => {
  it('posts the reply token and messages with a Bearer token', async () => {
    const { client, calls } = stubFetch(200)
    await client.reply('rt', [{ type: 'text', text: 'x' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/reply')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
    expect(headersOf(calls[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      replyToken: 'rt',
      messages: [{ type: 'text', text: 'x' }],
    })
  })

  it('throws AdapterError "line reply 500" on a non-2xx answer', async () => {
    const { client } = stubFetch(500, { message: 'secret detail' })
    const err = await client.reply('rt', [{ type: 'text', text: 'x' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('line reply 500')
  })
})

describe('LineHttpClient.getGroupMemberProfile', () => {
  it('returns the display name on 200', async () => {
    const { client, calls } = stubFetch(200, { displayName: 'Pim', userId: 'U1' })
    await expect(client.getGroupMemberProfile('C1', 'U1')).resolves.toEqual({ displayName: 'Pim' })
    expect(calls[0].init.method ?? 'GET').toBe('GET')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
  })

  it('returns null on 404', async () => {
    const { client } = stubFetch(404)
    await expect(client.getGroupMemberProfile('C1', 'U1')).resolves.toBeNull()
  })

  it('throws AdapterError on other statuses', async () => {
    const { client } = stubFetch(500)
    await expect(client.getGroupMemberProfile('C1', 'U1')).rejects.toThrow(new AdapterError('line profile 500'))
  })

  it('encodes the group and user IDs in the path', async () => {
    const { client, calls } = stubFetch(200, { displayName: 'Pim' })
    await client.getGroupMemberProfile('C/1?x', 'U#2')
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/group/C%2F1%3Fx/member/U%232')
  })
})

describe('LineHttpClient.verifyIdToken', () => {
  it('posts a form body with id_token and client_id and maps sub and name', async () => {
    const { client, calls } = stubFetch(200, { sub: 'U1', name: 'Pim', aud: '1234' })
    await expect(client.verifyIdToken('idt')).resolves.toEqual({ lineUserId: 'U1', displayName: 'Pim' })
    expect(calls[0].url).toBe('https://api.line.me/oauth2/v2.1/verify')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(String(calls[0].init.body))
    expect(form.get('id_token')).toBe('idt')
    expect(form.get('client_id')).toBe('1234')
  })

  it('maps a missing name to null', async () => {
    const { client } = stubFetch(200, { sub: 'U1' })
    await expect(client.verifyIdToken('idt')).resolves.toEqual({ lineUserId: 'U1', displayName: null })
  })

  it('returns null on 400 (rejected token)', async () => {
    const { client } = stubFetch(400, { error: 'invalid_request' })
    await expect(client.verifyIdToken('idt')).resolves.toBeNull()
  })

  it('throws AdapterError on other statuses', async () => {
    const { client } = stubFetch(503)
    await expect(client.verifyIdToken('idt')).rejects.toThrow(new AdapterError('line verify 503'))
  })
})
