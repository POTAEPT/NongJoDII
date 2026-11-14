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

describe('google sign-in start for a change of account (#14)', () => {
  async function confirmedOwner(h: ReturnType<typeof setup>) {
    const g = h.store.seedGroup({ lineGroupId: 'Cmain', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  }

  it('2c. the confirmed Owner of a Project gets a url that makes Google ask which account', async () => {
    const h = setup()
    await confirmedOwner(h)
    const res = await start(h, { idToken: OWNER_TOKEN, change: true })
    expect(res.status).toBe(200)
    const url = new URL((res.body as { url: string }).url)
    expect(url.searchParams.get('choose_account')).toBe('1')
    expect(openState(url.searchParams.get('state') as string, TEST_NOW, TEST_KEY)).toEqual({ lineUserId: OWNER })
  })

  it('2d. anyone else is refused with 403, and gets no url', async () => {
    const h = setup()
    expect(await start(h, { idToken: OWNER_TOKEN, change: true })).toEqual({ status: 403, body: { error: 'not_owner' } })
    // Named as Owner but not confirmed yet: still refused.
    const g = h.store.seedGroup({ lineGroupId: 'Cmain', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await start(h, { idToken: OWNER_TOKEN, change: true })).status).toBe(403)
  })

  it('2e. a plain sign-in does not ask which account, whoever starts it', async () => {
    const h = setup()
    const res = await start(h)
    expect(new URL((res.body as { url: string }).url).searchParams.get('choose_account')).toBeNull()
    expect((await start(h, { idToken: OWNER_TOKEN, change: 'yes' })).status).toBe(200) // only `true` asks for a change
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
  const href = (id: string) => `https://liff.line.me/${TEST_LIFF_ID}?view=google&amp;id=${id}`
  it('11. ok and every failure outcome carry the LIFF return button', async () => {
    for (const o of ['ok', 'cancelled', 'expired', 'missing_scope', 'no_refresh_token', 'failed'] as const) {
      const html = await renderCallbackPage(o, TEST_LIFF_ID).text()
      // #14: only a finished sign-in returns with id=done, which the view greets as a
      // success. The others return with id=back: with a change of account the old account
      // is still connected, and a cancelled or failed change must not read as done.
      expect(html).toContain(`<a class="back" href="${href(o === 'ok' ? 'done' : 'back')}">กลับไปที่ LINE</a>`)
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

  const NONE = { connected: false, signInAgain: false, canChange: false, changePending: false, signedInAt: null }

  it('13. no Google account gives connected false', async () => {
    const h = setup()
    expect(await status(h)).toEqual({ status: 200, body: NONE })
  })

  it('14. after a successful sign-in gives connected true, with the time of that sign-in', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    expect(await status(h)).toEqual({
      status: 200, body: { connected: true, signInAgain: false, canChange: false, changePending: false, signedInAt: TEST_NOW.toISOString() },
    })
  })

  it('15. a revoked or expired account gives connected false and asks to sign in again (#14)', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    for (const tokenStatus of ['revoked', 'expired'] as const) {
      h.store.tables.google_accounts[0].tokenStatus = tokenStatus
      expect(await status(h)).toEqual({
        status: 200, body: { connected: false, signInAgain: true, canChange: false, changePending: false, signedInAt: TEST_NOW.toISOString() },
      })
    }
  })

  it('15b. only the confirmed Owner of a Project may change the account (#14)', async () => {
    const h = setup()
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    const g = h.store.seedGroup({ lineGroupId: 'Cmain', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await status(h)).body).toMatchObject({ connected: true, canChange: false }) // named, not confirmed
    expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
    expect((await status(h)).body).toMatchObject({ connected: true, canChange: true })
    // A later sign-in moves the time the page compares against.
    h.setNow(new Date(TEST_NOW.getTime() + MIN))
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    expect((await status(h)).body).toMatchObject({ signedInAt: new Date(TEST_NOW.getTime() + MIN).toISOString() })
  })

  it('15c. a change of account that did not finish is reported, until a sign-in finishes it (#14)', async () => {
    const h = setup()
    const g = h.store.seedGroup({ lineGroupId: 'Cmain', nominatedOwnerLineUserId: OWNER })
    h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
    expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
    const signIn = async (subject: string) => {
      h.google.exchangeResult = { ...(h.google.exchangeResult as object), subject, refreshToken: `rt-${subject}` } as never
      const outcome = await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)
      await h.runDeferred()
      return outcome
    }
    expect(await signIn('g-sub-1')).toBe('ok')
    expect((await status(h)).body).toMatchObject({ connected: true, canChange: true, changePending: false })

    // The store fails while the old connection is retired: the new account is stored and
    // valid, but the Project is still connected to the old one.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.store.failNext('retireDriveConnection')
    h.setNow(new Date(TEST_NOW.getTime() + MIN))
    expect(await signIn('g-sub-2')).toBe('failed')
    expect((await status(h)).body).toMatchObject({ connected: true, canChange: true, changePending: true })

    h.setNow(new Date(TEST_NOW.getTime() + 2 * MIN))
    expect(await signIn('g-sub-2')).toBe('ok')
    expect((await status(h)).body).toMatchObject({ connected: true, changePending: false })
    vi.restoreAllMocks()
  })

  it('16. another user sees only their own status (client lineUserId ignored)', async () => {
    const h = setup()
    h.line.idTokens.set('idtok-other', { lineUserId: 'Uother', displayName: null })
    expect(await finishGoogleSignIn(h.deps, params({ code: 'c', state: await startedState(h) }), h.defer)).toBe('ok')
    expect(await status(h, { idToken: 'idtok-other', lineUserId: OWNER })).toEqual({ status: 200, body: NONE })
  })
})
