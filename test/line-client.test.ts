import { describe, expect, it } from 'vitest'
import { LineHttpClient } from '@/server/line/client'
import { AdapterError, LinePushRejected } from '@/server/log'

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

describe('LineHttpClient.push', () => {
  it('posts the group ID and messages with a Bearer token', async () => {
    const { client, calls } = stubFetch(200)
    await client.push('Cgroup1', [{ type: 'text', text: 'x' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/push')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
    expect(headersOf(calls[0]).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      to: 'Cgroup1',
      messages: [{ type: 'text', text: 'x' }],
    })
  })

  it('throws AdapterError "line push 429" without the response body', async () => {
    const { client } = stubFetch(429, { message: 'secret detail' })
    const err = await client.push('Cgroup1', [{ type: 'text', text: 'x' }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('line push 429')
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

describe('LineHttpClient timeout', () => {
  it('cuts a LINE call that does not answer and throws AdapterError "line timeout"', async () => {
    // A fetch that only ends when its signal aborts, like a LINE call that hangs.
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    const client = new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl, timeoutMs: 20 })
    const err = await client.getGroupMemberProfile('Cg', 'Uu').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('line timeout')
  })
})

describe('LineHttpClient.push', () => {
  it('posts the target and messages', async () => {
    const { client, calls } = stubFetch(200)
    await client.push('C1', [{ type: 'text', text: 'x' }])
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/message/push')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ to: 'C1', messages: [{ type: 'text', text: 'x' }] })
  })

  it('throws AdapterError "line push 429" on a non-2xx answer', async () => {
    const { client } = stubFetch(429, { message: 'secret detail' })
    await expect(client.push('C1', [{ type: 'text', text: 'x' }])).rejects.toThrow('line push 429')
  })
})

describe('LineHttpClient.getGroupMemberCount', () => {
  it('returns the count, with the URL and Bearer token', async () => {
    const { client, calls } = stubFetch(200, { count: 7 })
    await expect(client.getGroupMemberCount('C/1')).resolves.toBe(7)
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/group/C%2F1/members/count')
    expect(calls[0].init.method).toBe('GET')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
  })

  it('throws AdapterError on 404 and 500', async () => {
    await expect(stubFetch(404).client.getGroupMemberCount('C1')).rejects.toThrow(new AdapterError('line member count 404'))
    await expect(stubFetch(500).client.getGroupMemberCount('C1')).rejects.toThrow(new AdapterError('line member count 500'))
  })

  it('throws AdapterError when a 200 has no usable count', async () => {
    for (const body of [{}, { count: -1 }, { count: 1.5 }]) {
      await expect(stubFetch(200, body).client.getGroupMemberCount('C1')).rejects.toThrow(new AdapterError('line member count 200'))
    }
  })
})

describe('LineHttpClient.getGroupSummary', () => {
  it('returns the group name, with the URL and Bearer token', async () => {
    const { client, calls } = stubFetch(200, { groupId: 'C/1', groupName: 'ทีมงาน', pictureUrl: 'https://x' })
    await expect(client.getGroupSummary('C/1')).resolves.toEqual({ groupName: 'ทีมงาน' })
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/group/C%2F1/summary')
    expect(calls[0].init.method).toBe('GET')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
  })

  it('returns null on 404 and throws AdapterError on 500 or a 200 without a name', async () => {
    await expect(stubFetch(404).client.getGroupSummary('C1')).resolves.toBeNull()
    await expect(stubFetch(500).client.getGroupSummary('C1')).rejects.toThrow(new AdapterError('line group summary 500'))
    await expect(stubFetch(200, { groupId: 'C1' }).client.getGroupSummary('C1')).rejects.toThrow(new AdapterError('line group summary 200'))
  })
})

describe('LineHttpClient.getMessageQuota', () => {
  function quotaFetch(quota: unknown, usage: unknown, status = 200) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const body = String(input).endsWith('/consumption') ? usage : quota
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch
    return new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl })
  }

  it('returns the limit and the messages counted this month', async () => {
    await expect(quotaFetch({ type: 'limited', value: 300 }, { totalUsage: 42 }).getMessageQuota())
      .resolves.toEqual({ limit: 300, used: 42 })
  })

  it('returns limit null when the plan has no limit', async () => {
    await expect(quotaFetch({ type: 'none' }, { totalUsage: 5 }).getMessageQuota()).resolves.toEqual({ limit: null, used: 5 })
  })

  it('throws AdapterError on a bad answer', async () => {
    await expect(quotaFetch({ type: 'limited' }, { totalUsage: 1 }).getMessageQuota()).rejects.toBeInstanceOf(AdapterError)
    await expect(quotaFetch({}, {}, 500).getMessageQuota()).rejects.toThrow('line quota 500')
  })
})

describe('LineHttpClient.push retry key', () => {
  it('sends X-Line-Retry-Key and resolves sent when LINE accepts (200)', async () => {
    const { client, calls } = stubFetch(200)
    await expect(client.push('C1', [{ type: 'text', text: 'x' }], { retryKey: 'k-1' })).resolves.toBe('sent')
    expect(headersOf(calls[0]).get('X-Line-Retry-Key')).toBe('k-1')
  })

  it('resolves sent for a 200 without a retry key', async () => {
    const { client, calls } = stubFetch(200)
    await expect(client.push('C1', [{ type: 'text', text: 'x' }])).resolves.toBe('sent')
    expect(headersOf(calls[0]).get('X-Line-Retry-Key')).toBeNull()
  })

  it('resolves duplicate on 409 with a retry key (a request with this key was already accepted)', async () => {
    const { client, calls } = stubFetch(409, { message: 'The retry key is already accepted' })
    await expect(client.push('C1', [{ type: 'text', text: 'x' }], { retryKey: 'k-1' })).resolves.toBe('duplicate')
    expect(headersOf(calls[0]).get('X-Line-Retry-Key')).toBe('k-1')
  })

  it('a 409 without a retry key is still an error', async () => {
    const { client } = stubFetch(409)
    await expect(client.push('C1', [{ type: 'text', text: 'x' }])).rejects.toThrow('line push 409')
  })
})

// A caller that booked the push must know whether LINE certainly sent nothing (a 4xx) or
// may have delivered it (anything else).
describe('LineHttpClient.push failure kinds', () => {
  const push = (client: LineHttpClient, retryKey?: string) =>
    client.push('C1', [{ type: 'text', text: 'x' }], retryKey ? { retryKey } : undefined).catch((e: unknown) => e)

  it.each([400, 401, 403, 429])('a %i is a LinePushRejected with the status, same message as before', async (status) => {
    const err = await push(stubFetch(status, { message: 'secret detail' }).client, 'k-1')
    expect(err).toBeInstanceOf(LinePushRejected)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as LinePushRejected).status).toBe(status)
    expect((err as Error).message).toBe(`line push ${status}`)
  })

  it('a 409 without a retry key is a rejection, not a duplicate', async () => {
    const err = await push(stubFetch(409).client)
    expect(err).toBeInstanceOf(LinePushRejected)
    expect((err as LinePushRejected).status).toBe(409)
  })

  it.each([500, 502, 503])('a %i is not a rejection: LINE may have delivered the push', async (status) => {
    const err = await push(stubFetch(status).client, 'k-1')
    expect(err).toBeInstanceOf(AdapterError)
    expect(err).not.toBeInstanceOf(LinePushRejected)
    expect((err as Error).message).toBe(`line push ${status}`)
  })

  it('a network error is not a rejection', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const err = await push(new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl }), 'k-1')
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(LinePushRejected)
  })

  it('a timeout is not a rejection', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    const err = await push(new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl, timeoutMs: 20 }), 'k-1')
    expect(err).toBeInstanceOf(AdapterError)
    expect(err).not.toBeInstanceOf(LinePushRejected)
    expect((err as Error).message).toBe('line timeout')
  })
})

describe('LineHttpClient.getMessageContent (#4)', () => {
  function stubBinary(status: number, bytes: Uint8Array, contentType: string | null) {
    const calls: Call[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} })
      const headers = new Headers()
      if (contentType) headers.set('Content-Type', contentType)
      return new Response(status === 200 ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null, { status, headers })
    }) as typeof fetch
    return { client: new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl }), calls }
  }

  it('downloads the bytes from the data host with a Bearer token', async () => {
    const { client, calls } = stubBinary(200, new Uint8Array([1, 2, 3]), 'image/jpeg')
    const got = await client.getMessageContent('m/1', { timeoutMs: 5_000 })
    expect(calls[0].url).toBe('https://api-data.line.me/v2/bot/message/m%2F1/content')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    expect([...got!.data]).toEqual([1, 2, 3])
    expect(got!.contentType).toBe('image/jpeg')
  })

  it('answers null on a 404 (content gone)', async () => {
    const { client } = stubBinary(404, new Uint8Array(), null)
    expect(await client.getMessageContent('m1', { timeoutMs: 5_000 })).toBeNull()
  })

  it('throws "line content 202" while the content is not ready', async () => {
    const { client } = stubBinary(202, new Uint8Array(), null)
    const err = await client.getMessageContent('m1', { timeoutMs: 5_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('line content 202')
  })

  it('turns a timeout into AdapterError "line timeout"', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' })))
      })) as typeof fetch
    const client = new LineHttpClient({ channelAccessToken: 'tok', loginChannelId: '1234', fetchImpl })
    const err = await client.getMessageContent('m1', { timeoutMs: 5 }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('line timeout')
  })
})

describe('LineHttpClient.leaveGroup (#11)', () => {
  it('posts to the leave endpoint with the Bearer token and answers left on 200', async () => {
    const { client, calls } = stubFetch(200)
    await expect(client.leaveGroup('C/1')).resolves.toBe('left')
    expect(calls[0].url).toBe('https://api.line.me/v2/bot/group/C%2F1/leave')
    expect(calls[0].init.method).toBe('POST')
    expect(headersOf(calls[0]).get('Authorization')).toBe('Bearer tok')
  })

  it('answers not_in_group on 404 and throws AdapterError on 400 or 500', async () => {
    await expect(stubFetch(404).client.leaveGroup('C1')).resolves.toBe('not_in_group')
    await expect(stubFetch(400).client.leaveGroup('C1')).rejects.toThrow(new AdapterError('line leave 400'))
    await expect(stubFetch(500).client.leaveGroup('C1')).rejects.toThrow(new AdapterError('line leave 500'))
  })
})
