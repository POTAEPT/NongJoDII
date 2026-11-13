import { describe, expect, it, vi } from 'vitest'
import { open, openState, sealState } from '@/server/crypto/secretbox'
import { finishGoogleSignIn, renderCallbackPage } from '@/server/google/callback'
import { startGoogleSignIn } from '@/server/google/start'
import { googleStatus } from '@/server/google/status'
import { makeTestDeps, TEST_KEY, TEST_LIFF_ID, TEST_NOW } from './harness'

const MIN = 60_000
const OWNER = 'Uowner1'
const OWNER_TOKEN = 'idtok-owner'

function setup() {
  const h = makeTestDeps()
  h.line.idTokens.set(OWNER_TOKEN, { lineUserId: OWNER, displayName: 'Owner Name' })
  return h
}

function stateFromUrl(url: string): string {
  return new URL(url).searchParams.get('state') as string
}

async function start(h: ReturnType<typeof setup>, body: unknown = { idToken: OWNER_TOKEN }) {
  return startGoogleSignIn(h.deps, body)
}

async function startedState(h: ReturnType<typeof setup>): Promise<string> {
  const res = await start(h)
  return stateFromUrl((res.body as { url: string }).url)
}

function params(p: Record<string, string>): URLSearchParams {
  return new URLSearchParams(p)
}

describe('google sign-in start', () => {
  it('1. an unknown token gives 401 and touches nothing', async () => {
    const h = setup()
    const res = await start(h, { idToken: 'nope' })
    expect(res).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(h.store.tables.line_users).toHaveLength(0)
  })

  it('1b. a non-string or missing token gives 401 without calling LINE', async () => {
    const h = setup()
    for (const body of [{}, { idToken: 42 }, { idToken: '' }, null, 'x']) {
      expect((await start(h, body)).status).toBe(401)
    }
    expect(h.line.verifyCalls).toHaveLength(0)
  })

  it('2. a valid token gives a url whose state opens back to the user, and stores the LINE user', async () => {
    const h = setup()
    const res = await start(h)
    expect(res.status).toBe(200)
    const state = stateFromUrl((res.body as { url: string }).url)
    expect(openState(state, TEST_NOW, TEST_KEY)).toEqual({ lineUserId: OWNER })
    expect(h.store.tables.line_users.find((u) => u.lineUserId === OWNER)?.displayName).toBe('Owner Name')
  })

  it('2b. a client-sent lineUserId is ignored', async () => {
    const h = setup()
    const res = await start(h, { idToken: OWNER_TOKEN, lineUserId: 'Uattacker', userId: 'Uattacker' })
    const state = stateFromUrl((res.body as { url: string }).url)
    expect(openState(state, TEST_NOW, TEST_KEY)).toEqual({ lineUserId: OWNER })
    expect(h.line.verifyCalls.length).toBe(1)
    expect(h.store.tables.line_users.some((u) => u.lineUserId === 'Uattacker')).toBe(false)
  })
})

describe('google sign-in callback', () => {
  it('3. happy path stores the account with the refresh token encrypted', async () => {
    const h = setup()
    const state = await startedState(h)
    const outcome = await finishGoogleSignIn(h.deps, params({ code: 'code-1', state }), h.defer)
    expect(outcome).toBe('ok')
    expect(h.google.exchangedCodes).toEqual(['code-1'])
    expect(h.store.tables.google_accounts).toHaveLength(1)
    const row = h.store.tables.google_accounts[0]
    expect(row.lineUserId).toBe(OWNER)
    expect(row.googleSubject).toBe('g-sub-1')
    expect(row.email).toBe('owner@example.com')
    expect(row.grantedScopes).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/drive.file'])
    expect(row.tokenStatus).toBe('valid')
    const ct = row.refreshTokenCiphertext as string
    expect(ct).not.toBe('rt-1')
    expect(ct.includes('rt-1')).toBe(false)
    expect(open(ct, TEST_KEY)).toBe('rt-1')
  })

  it('4. error=access_denied gives cancelled, with no row and no exchange', async () => {
    const h = setup()
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ error: 'access_denied', state }), h.defer)).toBe('cancelled')
    expect(h.google.exchangedCodes).toHaveLength(0)
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('4b. any other error gives failed', async () => {
    const h = setup()
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ error: 'server_error', state }), h.defer)).toBe('failed')
    expect(h.google.exchangedCodes).toHaveLength(0)
  })

  it('5. an expired state (+11 min) gives expired', async () => {
    const h = setup()
    const state = await startedState(h)
    h.setNow(new Date(TEST_NOW.getTime() + 11 * MIN))
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('expired')
    expect(h.google.exchangedCodes).toHaveLength(0)
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('5b. a forged state gives expired', async () => {
    const h = setup()
    const forged = sealState(OWNER, TEST_NOW, Buffer.alloc(32, 9))
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: forged }), h.defer)).toBe('expired')
    expect(h.google.exchangedCodes).toHaveLength(0)
  })

  it('6. scopes without drive.file give missing_scope, with no row', async () => {
    const h = setup()
    h.google.exchangeResult = { refreshToken: 'rt-1', scopes: ['openid', 'email'], subject: 'g-sub-1', email: null }
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('missing_scope')
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('7. refreshToken null gives no_refresh_token', async () => {
    const h = setup()
    h.google.exchangeResult = {
      refreshToken: null, scopes: ['openid', 'https://www.googleapis.com/auth/drive.file'], subject: 'g-sub-1', email: null,
    }
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('no_refresh_token')
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('8. an exchange throw gives failed', async () => {
    const h = setup()
    h.google.exchangeResult = new Error('boom')
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('failed')
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('8b. subject null gives failed, with no row', async () => {
    const h = setup()
    h.google.exchangeResult = {
      refreshToken: 'rt-1', scopes: ['https://www.googleapis.com/auth/drive.file'], subject: null, email: null,
    }
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('failed')
    expect(h.store.tables.google_accounts).toHaveLength(0)
  })

  it('8c. missing code or missing state gives expired without an exchange', async () => {
    const h = setup()
    const state = await startedState(h)
    expect(await finishGoogleSignIn(h.deps, params({ state }), h.defer)).toBe('expired')
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c' }), h.defer)).toBe('expired')
    expect(h.google.exchangedCodes).toHaveLength(0)
  })

  it('8d. a store failure gives failed', async () => {
    const h = setup()
    const state = await startedState(h)
    h.store.failNext('upsertGoogleAccount')
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state }), h.defer)).toBe('failed')
  })

  it('9. signing in twice with the same subject keeps one row and updates the ciphertext', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c1', state: await startedState(h) }), h.defer)).toBe('ok')
    const first = h.store.tables.google_accounts[0].refreshTokenCiphertext as string
    h.google.exchangeResult = {
      refreshToken: 'rt-2', scopes: ['openid', 'https://www.googleapis.com/auth/drive.file'], subject: 'g-sub-1', email: 'owner@example.com',
    }
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c2', state: await startedState(h) }), h.defer)).toBe('ok')
    expect(h.store.tables.google_accounts).toHaveLength(1)
    const second = h.store.tables.google_accounts[0].refreshTokenCiphertext as string
    expect(second).not.toBe(first)
    expect(open(second, TEST_KEY)).toBe('rt-2')
  })
})

describe('callback log', () => {
  it('logs only the outcome', async () => {
    const h = setup()
    const state = await startedState(h)
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      await finishGoogleSignIn(h.deps, params({ code: 'code-1', state }), h.defer)
      expect(info.mock.calls).toEqual([[JSON.stringify({ event: 'google_signin', outcome: 'ok' })]])
    } finally {
      info.mockRestore()
    }
  })
})

describe('renderCallbackPage', () => {
  it('10. cancelled is a 400 Thai page with the cancel copy', async () => {
    const res = renderCallbackPage('cancelled', TEST_LIFF_ID)
    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain('<!doctype html><html lang="th">')
    expect(html).toContain('<title>NongJoDII</title>')
    expect(html).toContain('ยกเลิกการเข้าสู่ระบบ Google')
  })

  it('ok is 200 with the success copy; every outcome has one h1 and one p', async () => {
    const ok = renderCallbackPage('ok', TEST_LIFF_ID)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('เชื่อม Google Drive สำเร็จ')
    for (const o of ['ok', 'cancelled', 'expired', 'missing_scope', 'no_refresh_token', 'failed'] as const) {
      const html = await renderCallbackPage(o, TEST_LIFF_ID).text()
      expect(html.match(/<h1>/g)).toHaveLength(1)
      expect(html.match(/<p>/g)).toHaveLength(1)
    }
  })
})

describe('renderCallbackPage return to LINE', () => {
  const href = `https://liff.line.me/${TEST_LIFF_ID}?view=google&amp;id=done`
  it('11. ok and every failure outcome carry the LIFF return button', async () => {
    for (const o of ['ok', 'cancelled', 'expired', 'missing_scope', 'no_refresh_token', 'failed'] as const) {
      const html = await renderCallbackPage(o, TEST_LIFF_ID).text()
      expect(html).toContain(`<a class="back" href="${href}">กลับไปที่ LINE</a>`)
    }
  })
})

describe('google status', () => {
  const status = (h: ReturnType<typeof setup>, body: unknown = { idToken: OWNER_TOKEN }) => googleStatus(h.deps, body)

  it('12. a bad or missing token gives 401', async () => {
    const h = setup()
    for (const body of [{ idToken: 'nope' }, {}, { idToken: 42 }, null]) {
      expect(await status(h, body)).toEqual({ status: 401, body: { error: 'unauthorized' } })
    }
  })

  it('13. no Google account gives connected false', async () => {
    const h = setup()
    expect(await status(h)).toEqual({ status: 200, body: { connected: false } })
  })

  it('14. after a successful sign-in gives connected true', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    expect(await status(h)).toEqual({ status: 200, body: { connected: true } })
  })

  it('15. a revoked account gives connected false', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    h.store.tables.google_accounts[0].tokenStatus = 'revoked'
    expect(await status(h)).toEqual({ status: 200, body: { connected: false } })
  })

  it('16. another user sees only their own status (client lineUserId ignored)', async () => {
    const h = setup()
    h.line.idTokens.set('idtok-other', { lineUserId: 'Uother', displayName: null })
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    expect(await status(h, { idToken: 'idtok-other', lineUserId: OWNER })).toEqual({ status: 200, body: { connected: false } })
  })
})
