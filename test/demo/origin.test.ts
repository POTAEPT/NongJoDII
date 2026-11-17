import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDemo, noteDemoOrigin } from '@/server/demo/demo-deps'

// The demo's Google callback and card links follow the port the demo server is on
// (`next dev -p 3001`), not a hard-coded :3000. DEMO_BASE_URL still wins when set.

const KEY = Symbol.for('nongjodii.demo')
const redirectOf = (authUrl: string) => new URL(authUrl).searchParams.get('redirect_uri')

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[KEY]
  vi.stubEnv('DEMO_BASE_URL', '')
  vi.stubEnv('PORT', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as Record<symbol, unknown>)[KEY]
})

describe('demo origin', () => {
  it('a request on :3001 moves the Google redirect URI and appBaseUrl to :3001', () => {
    noteDemoOrigin(new Request('http://localhost:3001/demo/api/sim/state'))
    const { deps } = getDemo()
    expect(redirectOf(deps.google.buildAuthUrl('s'))).toBe('http://localhost:3001/demo/api/google/callback')
    expect(deps.config.appBaseUrl).toBe('http://localhost:3001')
  })

  it('the demo built before the first request follows it too, and another origin switches again', () => {
    const { deps } = getDemo()
    expect(redirectOf(deps.google.buildAuthUrl('s'))).toBe('http://localhost:3000/demo/api/google/callback')
    noteDemoOrigin(new Request('http://localhost:3001/demo/api/google/start', { method: 'POST' }))
    expect(redirectOf(deps.google.buildAuthUrl('s'))).toBe('http://localhost:3001/demo/api/google/callback')
    noteDemoOrigin(new Request('http://127.0.0.1:4000/demo/api/sim/state'))
    expect(redirectOf(deps.google.buildAuthUrl('s'))).toBe('http://127.0.0.1:4000/demo/api/google/callback')
    expect(deps.config.appBaseUrl).toBe('http://127.0.0.1:4000')
  })

  it('before any request it uses PORT', () => {
    vi.stubEnv('PORT', '3001')
    expect(redirectOf(getDemo().deps.google.buildAuthUrl('s'))).toBe('http://localhost:3001/demo/api/google/callback')
  })

  it('DEMO_BASE_URL wins over the request origin', () => {
    vi.stubEnv('DEMO_BASE_URL', 'https://demo.example.dev/')
    noteDemoOrigin(new Request('http://localhost:3001/demo/api/sim/state'))
    const { deps } = getDemo()
    expect(redirectOf(deps.google.buildAuthUrl('s'))).toBe('https://demo.example.dev/demo/api/google/callback')
    expect(deps.config.appBaseUrl).toBe('https://demo.example.dev')
  })
})
