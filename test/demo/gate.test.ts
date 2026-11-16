import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as catchAllGet, POST as catchAllPost } from '@/app/demo/api/[...path]/route'
import { GET as contentGet } from '@/app/demo/api/sim/content/[messageId]/route'
import { GET as simGet, POST as simPost } from '@/app/demo/api/sim/[action]/route'
import { demoEnabled } from '@/server/demo/gate'
import { runSimAction } from '@/server/demo/sim'

const params = <T,>(p: T) => ({ params: Promise.resolve(p) })
const post = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) })

describe('/demo gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is off without DEMO_MODE, and on Vercel production even with it', () => {
    vi.stubEnv('DEMO_MODE', '')
    expect(demoEnabled()).toBe(false)
    vi.stubEnv('DEMO_MODE', '1')
    expect(demoEnabled()).toBe(true)
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(demoEnabled()).toBe(false)
  })

  it('answers 404 on a sim route, a same-path route and the content route when off', async () => {
    vi.stubEnv('DEMO_MODE', '')
    expect((await simGet(new Request('http://localhost/demo/api/sim/state'), params({ action: 'state' }))).status).toBe(404)
    expect((await simPost(post({}), params({ action: 'reset' }))).status).toBe(404)
    expect((await catchAllPost(post({ idToken: 'demo:x' }), params({ path: ['review', 'load'] }))).status).toBe(404)
    expect((await catchAllGet(new Request('http://localhost/demo/api/google/callback'), params({ path: ['google', 'callback'] }))).status).toBe(404)
    expect((await contentGet(new Request('http://localhost/x'), params({ messageId: 'm1' }))).status).toBe(404)
  })

  it('is off on a Vercel preview deployment too, even with DEMO_MODE=1', async () => {
    vi.stubEnv('DEMO_MODE', '1')
    vi.stubEnv('VERCEL', '1')
    expect(demoEnabled()).toBe(false)
    vi.unstubAllEnvs()
    vi.stubEnv('DEMO_MODE', '1')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(demoEnabled()).toBe(false)
    expect((await simGet(new Request('http://localhost/demo/api/sim/state'), params({ action: 'state' }))).status).toBe(404)
  })

  it('answers 404 on Vercel production even with DEMO_MODE=1', async () => {
    vi.stubEnv('DEMO_MODE', '1')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect((await simGet(new Request('http://localhost/demo/api/sim/state'), params({ action: 'state' }))).status).toBe(404)
  })

  it('serves uploaded bytes from the content route when on', async () => {
    vi.stubEnv('DEMO_MODE', '1')
    await runSimAction('reset', 'POST', {})
    const sent = await runSimAction('send', 'POST', {
      persona: 'bomb', type: 'image', fileName: 'a.png', contentType: 'image/png', dataBase64: Buffer.from('PNGDATA').toString('base64'),
    })
    const { messageId } = sent.body as { messageId: string }
    const res = await contentGet(new Request('http://localhost/x'), params({ messageId }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA')
  })

  it('serves the state when on', async () => {
    vi.stubEnv('DEMO_MODE', '1')
    const res = await simGet(new Request('http://localhost/demo/api/sim/state'), params({ action: 'state' }))
    expect(res.status).toBe(200)
    const state = (await res.json()) as { liffId: string; personas: unknown[] }
    expect(state.liffId).toBe('demo-liff')
    expect(state.personas).toHaveLength(4)
  })
})
