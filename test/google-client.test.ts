import { describe, expect, it } from 'vitest'
import { DRIVE_FILE_SCOPE, GoogleHttpClient } from '@/server/google/client'
import { AdapterError } from '@/server/log'

type Call = { url: string; init: RequestInit }

const REDIRECT = 'https://app.example/api/google/callback'

function stubFetch(status: number, body: unknown = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const client = new GoogleHttpClient({ clientId: 'cid', clientSecret: 'csecret', redirectUri: REDIRECT, fetchImpl })
  return { client, calls }
}

/** Hand-built unsigned JWT: header.payload.sig, base64url JSON. */
function jwt(payload: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(payload)}.sig`
}

describe('GoogleHttpClient.buildAuthUrl', () => {
  it('builds the Google auth URL with offline access, consent, scopes, redirect and state', () => {
    const { client, calls } = stubFetch(200)
    const url = new URL(client.buildAuthUrl('st-1'))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    const q = url.searchParams
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('redirect_uri')).toBe(REDIRECT)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('consent')
    expect(q.get('state')).toBe('st-1')
    const scopes = (q.get('scope') ?? '').split(' ')
    expect(scopes).toContain('openid')
    expect(scopes).toContain(DRIVE_FILE_SCOPE)
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file')
    expect(calls).toHaveLength(0)
  })
})

describe('GoogleHttpClient.exchangeCode', () => {
  it('posts the form fields to the token endpoint', async () => {
    const { client, calls } = stubFetch(200, { scope: 'openid', id_token: jwt({ sub: 's' }) })
    await client.exchangeCode('code-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const form = new URLSearchParams(calls[0].init.body as string)
    expect(Object.fromEntries(form)).toEqual({
      code: 'code-1',
      client_id: 'cid',
      client_secret: 'csecret',
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    })
  })

  it('parses scope into an array and decodes sub/email from the id_token', async () => {
    const { client } = stubFetch(200, {
      access_token: 'at',
      refresh_token: 'rt-1',
      scope: `openid  https://www.googleapis.com/auth/userinfo.email ${DRIVE_FILE_SCOPE}`,
      id_token: jwt({ sub: 'g-sub-1', email: 'owner@example.com' }),
    })
    await expect(client.exchangeCode('c')).resolves.toEqual({
      refreshToken: 'rt-1',
      scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', DRIVE_FILE_SCOPE],
      subject: 'g-sub-1',
      email: 'owner@example.com',
    })
  })

  it('gives refreshToken null when refresh_token is missing', async () => {
    const { client } = stubFetch(200, { scope: DRIVE_FILE_SCOPE, id_token: jwt({ sub: 'g' }) })
    const r = await client.exchangeCode('c')
    expect(r.refreshToken).toBeNull()
    expect(r.email).toBeNull()
  })

  it('gives subject null without an id_token, and empty scopes without scope', async () => {
    const { client } = stubFetch(200, { refresh_token: 'rt' })
    await expect(client.exchangeCode('c')).resolves.toEqual({ refreshToken: 'rt', scopes: [], subject: null, email: null })
  })

  it('throws AdapterError "google token 400" on a 400', async () => {
    const { client } = stubFetch(400, { error: 'invalid_grant', error_description: 'detail' })
    const err = await client.exchangeCode('c').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('google token 400')
  })
})
