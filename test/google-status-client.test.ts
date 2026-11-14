import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGoogleStatus, type GoogleStatusResult, phaseOnOpen, phaseOnReturn, returnVisit } from '@/app/liff/google-status'

const result = (status: GoogleStatusResult['status'], signedInAt: string | null = null, canChange = false): GoogleStatusResult =>
  ({ status, signedInAt, canChange })

describe('returnVisit (the id the callback page links back with)', () => {
  it('done: a return visit after a sign-in that finished', () => expect(returnVisit('done')).toEqual({ returning: true, signedIn: true }))
  it('back: a return visit after a sign-in that did not finish, never greeted as a success (#14)', () =>
    expect(returnVisit('back')).toEqual({ returning: true, signedIn: false }))
  it('anything else is a plain visit', () => {
    expect(returnVisit(null)).toEqual({ returning: false, signedIn: false })
    expect(returnVisit('x')).toEqual({ returning: false, signedIn: false })
  })
})

describe('phaseOnOpen (first load of the Google view)', () => {
  it('a connected account shows the connected screen instead of starting a new sign-in', () => {
    expect(phaseOnOpen(result('connected', 't1'), false)).toBe('connected')
    expect(phaseOnOpen(result('connected', 't1'), true)).toBe('connected')
  })
  it('a revoked or expired account shows the sign-in-again notice (#14)', () => {
    expect(phaseOnOpen(result('sign_in_again', 't1'), false)).toBe('sign_in_again')
    expect(phaseOnOpen(result('sign_in_again', 't1'), true)).toBe('sign_in_again')
  })
  it('no account starts sign-in, except on the return visit from the callback page', () => {
    expect(phaseOnOpen(result('not_connected'), false)).toBe('start')
    expect(phaseOnOpen(result('not_connected'), true)).toBe('not_connected')
  })
  it('unauthorized and failed show their errors', () => {
    expect(phaseOnOpen(result('unauthorized'), false)).toBe('unauthorized')
    expect(phaseOnOpen(result('failed'), false)).toBe('failed')
  })
})

describe('phaseOnReturn (back in LINE while sign-in is open in the browser)', () => {
  it('a first sign-in that finished shows success', () => expect(phaseOnReturn(result('connected', 't1'), null)).toBe('connected'))
  it('a new sign-in after the one known at the start shows success', () =>
    expect(phaseOnReturn(result('connected', 't2'), 't1')).toBe('connected'))
  it('a change of account that has not finished stays in opened: the old account is still connected (#14)', () =>
    expect(phaseOnReturn(result('connected', 't1'), 't1')).toBeNull())
  it('unauthorized shows the reopen-from-LINE error', () => expect(phaseOnReturn(result('unauthorized'), null)).toBe('unauthorized'))
  it('failed shows the retry error', () => expect(phaseOnReturn(result('failed'), null)).toBe('failed'))
  it('not_connected stays in opened', () => expect(phaseOnReturn(result('not_connected'), null)).toBeNull())
  it('sign_in_again stays in opened: the new sign-in has not finished', () =>
    expect(phaseOnReturn(result('sign_in_again', 't1'), 't1')).toBeNull())
})

describe('fetchGoogleStatus', () => {
  afterEach(() => vi.unstubAllGlobals())
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))

  it('sends only the id token', async () => {
    respond(200, { connected: true })
    await fetchGoogleStatus('tok')
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/google/status')
    expect(JSON.parse(init.body)).toEqual({ idToken: 'tok' })
  })
  it('200 connected true gives connected, with the sign-in time and the change right', async () => {
    respond(200, { connected: true, signInAgain: false, canChange: true, signedInAt: '2026-11-14T03:00:00.000Z' })
    expect(await fetchGoogleStatus('tok')).toEqual({ status: 'connected', canChange: true, signedInAt: '2026-11-14T03:00:00.000Z' })
  })
  it('200 connected false gives not_connected', async () => {
    respond(200, { connected: false })
    expect(await fetchGoogleStatus('tok')).toEqual({ status: 'not_connected', canChange: false, signedInAt: null })
  })
  it('200 signInAgain true gives sign_in_again', async () => {
    respond(200, { connected: false, signInAgain: true, canChange: false, signedInAt: '2026-11-14T03:00:00.000Z' })
    expect(await fetchGoogleStatus('tok')).toMatchObject({ status: 'sign_in_again', signedInAt: '2026-11-14T03:00:00.000Z' })
  })
  it('401 gives unauthorized', async () => {
    respond(401, { error: 'unauthorized' })
    expect((await fetchGoogleStatus('tok')).status).toBe('unauthorized')
  })
  it('500 gives failed', async () => {
    respond(500, {})
    expect((await fetchGoogleStatus('tok')).status).toBe('failed')
  })
  it('a network error gives failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchGoogleStatus('tok')).toEqual({ status: 'failed', canChange: false, signedInAt: null })
  })
})
