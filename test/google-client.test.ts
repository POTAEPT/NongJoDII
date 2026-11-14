import { describe, expect, it } from 'vitest'
import { DRIVE_FILE_SCOPE, GoogleHttpClient } from '@/server/google/client'
import { AdapterError, GoogleTokenRevoked } from '@/server/log'

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
    // #14: Google always shows its account chooser first, so the browser's default Google
    // account is never used without the person picking it; then consent, for the refresh token.
    expect(q.get('prompt')).toBe('select_account consent')
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

describe('GoogleHttpClient.accessToken', () => {
  it('posts grant_type=refresh_token and returns the access token', async () => {
    const { client, calls } = stubFetch(200, { access_token: 'at-1', expires_in: 3599 })
    await expect(client.accessToken('rt-1')).resolves.toBe('at-1')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.method).toBe('POST')
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body as string))).toEqual({
      client_id: 'cid', client_secret: 'csecret', refresh_token: 'rt-1', grant_type: 'refresh_token',
    })
  })

  it('rejects with GoogleTokenRevoked on invalid_grant', async () => {
    const { client } = stubFetch(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    const err = await client.accessToken('rt').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleTokenRevoked)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('google refresh invalid_grant')
  })

  it('throws a plain AdapterError on another failure, and when access_token is missing', async () => {
    const e500 = await stubFetch(500, {}).client.accessToken('rt').catch((e: unknown) => e)
    expect(e500).toBeInstanceOf(AdapterError)
    expect(e500).not.toBeInstanceOf(GoogleTokenRevoked)
    expect((e500 as Error).message).toBe('google refresh 500')
    const e400 = await stubFetch(400, { error: 'invalid_client' }).client.accessToken('rt').catch((e: unknown) => e)
    expect(e400).not.toBeInstanceOf(GoogleTokenRevoked)
    expect((e400 as Error).message).toBe('google refresh 400')
    const none = await stubFetch(200, {}).client.accessToken('rt').catch((e: unknown) => e)
    expect((none as Error).message).toBe('google refresh no access_token')
  })
})

describe('GoogleHttpClient Drive', () => {
  it('createFolder posts a folder with its parent and returns the id', async () => {
    const { client, calls } = stubFetch(200, { id: 'f-1' })
    await expect(client.createFolder('at-1', 'NongJoDII', 'p-1')).resolves.toBe('f-1')
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(url.searchParams.get('fields')).toBe('id')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('Authorization')).toBe('Bearer at-1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      name: 'NongJoDII', mimeType: 'application/vnd.google-apps.folder', parents: ['p-1'],
    })
  })

  it('createFolder with no parent leaves parents out (the Drive root)', async () => {
    const { client, calls } = stubFetch(200, { id: 'f-1' })
    await client.createFolder('at-1', 'NongJoDII', null)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: 'NongJoDII', mimeType: 'application/vnd.google-apps.folder' })
  })

  it('createFolder throws on an error status or a missing id', async () => {
    expect(((await stubFetch(403).client.createFolder('a', 'n', null).catch((e: unknown) => e)) as Error).message)
      .toBe('google drive create 403')
    expect(((await stubFetch(200, {}).client.createFolder('a', 'n', null).catch((e: unknown) => e)) as Error).message)
      .toBe('google drive create no id')
  })

  it('getFolder asks for the trashed field and maps ok, trashed and a 404', async () => {
    const ok = stubFetch(200, { id: 'f-1', trashed: false })
    await expect(ok.client.getFolder('at-1', 'f-1')).resolves.toBe('ok')
    const url = new URL(ok.calls[0].url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files/f-1')
    expect(url.searchParams.get('fields')).toBe('id,trashed')
    expect(ok.calls[0].init.method ?? 'GET').toBe('GET')
    expect(new Headers(ok.calls[0].init.headers).get('Authorization')).toBe('Bearer at-1')
    await expect(stubFetch(200, { id: 'f-1', trashed: true }).client.getFolder('a', 'f-1')).resolves.toBe('trashed')
    await expect(stubFetch(404, { error: {} }).client.getFolder('a', 'f-1')).resolves.toBe('missing')
  })

  it('getFolder encodes the id and throws on another error', async () => {
    const s = stubFetch(200, { trashed: false })
    await s.client.getFolder('a', 'a/b')
    expect(s.calls[0].url).toContain('/files/a%2Fb?')
    expect(((await stubFetch(500).client.getFolder('a', 'f').catch((e: unknown) => e)) as Error).message)
      .toBe('google drive get 500')
  })

  it('shareAnyoneReader creates one reader permission for anyone', async () => {
    const { client, calls } = stubFetch(200, { id: 'anyoneWithLink' })
    await client.shareAnyoneReader('at-1', 'f-1')
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files/f-1/permissions')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer at-1')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ role: 'reader', type: 'anyone' })
    expect(((await stubFetch(403).client.shareAnyoneReader('a', 'f').catch((e: unknown) => e)) as Error).message)
      .toBe('google drive share 403')
  })
})
