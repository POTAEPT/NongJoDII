import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGoogleStatus, phaseOnReturn } from '@/app/liff/google-status'

describe('phaseOnReturn', () => {
  it('connected shows success', () => expect(phaseOnReturn('connected')).toBe('connected'))
  it('unauthorized shows the reopen-from-LINE error', () => expect(phaseOnReturn('unauthorized')).toBe('unauthorized'))
  it('failed shows the retry error', () => expect(phaseOnReturn('failed')).toBe('failed'))
  it('not_connected stays in opened', () => expect(phaseOnReturn('not_connected')).toBeNull())
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
  it('200 connected true gives connected', async () => {
    respond(200, { connected: true })
    expect(await fetchGoogleStatus('tok')).toBe('connected')
  })
  it('200 connected false gives not_connected', async () => {
    respond(200, { connected: false })
    expect(await fetchGoogleStatus('tok')).toBe('not_connected')
  })
  it('401 gives unauthorized', async () => {
    respond(401, { error: 'unauthorized' })
    expect(await fetchGoogleStatus('tok')).toBe('unauthorized')
  })
  it('500 gives failed', async () => {
    respond(500, {})
    expect(await fetchGoogleStatus('tok')).toBe('failed')
  })
  it('a network error gives failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchGoogleStatus('tok')).toBe('failed')
  })
})
