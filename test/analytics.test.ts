import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_PARAMS, startAnalytics, track, withoutCredentials, type AnalyticsWindow } from '@/app/liff/analytics'

// #19 Clarity on the LIFF pages: loaded only after liff.init() resolved, never with a LINE
// credential in the URL, and only fixed event names.

function fakeWindow(search = '', hash = '') {
  const appended: { async: boolean; src: string; id: string }[] = []
  const replaced: string[] = []
  const w: AnalyticsWindow = {
    location: { pathname: '/liff', search, hash },
    history: { replaceState: (_d, _u, url) => { replaced.push(url) } },
    document: {
      createElement: () => ({ async: false, src: '', id: '' }),
      head: { appendChild: (n) => { appended.push(n as (typeof appended)[number]) } },
      getElementById: (id) => appended.find((s) => s.id === id) ?? null,
    },
  }
  return { w, appended, replaced }
}

describe('withoutCredentials', () => {
  it('removes each credential parameter from the search and the hash, and keeps ours', () => {
    for (const p of CREDENTIAL_PARAMS) {
      expect(withoutCredentials(`?view=task&id=t1&${p}=secret`, '')).toEqual({ search: '?view=task&id=t1', hash: '', changed: true })
      expect(withoutCredentials('?view=task', `#${p}=secret&x=1`)).toEqual({ search: '?view=task', hash: '#x=1', changed: true })
    }
    expect(withoutCredentials('?access_token=a&id_token=b', '#code=c&state=d')).toEqual({ search: '', hash: '', changed: true })
  })

  it('leaves a clean URL as it is', () => {
    expect(withoutCredentials('?view=dashboard&id=g1', '#tasks')).toEqual({ search: '?view=dashboard&id=g1', hash: '#tasks', changed: false })
    expect(withoutCredentials('', '')).toEqual({ search: '', hash: '', changed: false })
  })
})

describe('startAnalytics', () => {
  const on = { id: 'proj123', enabled: true }

  it('strips a leftover credential from the address bar before Clarity loads', () => {
    const { w, appended, replaced } = fakeWindow('?view=dashboard&access_token=secret', '')
    expect(startAnalytics(w, on)).toBe(true)
    expect(replaced).toEqual(['/liff?view=dashboard'])
    expect(appended).toHaveLength(1)
    expect(appended[0].src).toBe('https://www.clarity.ms/tag/proj123')
    expect(appended[0].src).not.toContain('secret')
  })

  it('loads the tag once, and queues events until it is ready', () => {
    const { w, appended } = fakeWindow('?view=task&id=t1')
    startAnalytics(w, on)
    startAnalytics(w, on)
    expect(appended).toHaveLength(1)
    w.clarity!('event', 'task_saved')
    expect(w.clarity!.q).toEqual([['event', 'task_saved']])
  })

  it('loads nothing outside production or without a project ID, but still strips the URL', () => {
    const off = fakeWindow('?id_token=x')
    expect(startAnalytics(off.w, { id: 'p', enabled: false })).toBe(false)
    expect(off.appended).toEqual([])
    expect(off.replaced).toEqual(['/liff'])
    expect(startAnalytics(fakeWindow().w, { id: undefined, enabled: true })).toBe(false)
  })
})

describe('initLiff starts analytics only after liff.init() resolved', () => {
  afterEach(() => {
    vi.doUnmock('@line/liff')
    vi.doUnmock('@/app/liff/analytics')
    vi.resetModules()
  })

  it('no Clarity before init; one start after it, for a logged-in user', async () => {
    let resolveInit!: () => void
    const init = vi.fn(() => new Promise<void>((r) => { resolveInit = r }))
    vi.doMock('@line/liff', () => ({ default: { init, isLoggedIn: () => true, getIDToken: () => 'tok' } }))
    const start = vi.fn()
    vi.doMock('@/app/liff/analytics', () => ({ startAnalytics: start }))
    const { initLiff } = await import('@/app/liff/liff-sdk')
    const pending = initLiff('liff-1')
    await new Promise((r) => setTimeout(r, 0))
    expect(init).toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    resolveInit()
    await pending
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('a user sent to LINE login never loads Clarity', async () => {
    vi.doMock('@line/liff', () => ({ default: { init: async () => {}, isLoggedIn: () => false, login: () => {} } }))
    const start = vi.fn()
    vi.doMock('@/app/liff/analytics', () => ({ startAnalytics: start }))
    vi.stubGlobal('window', { location: { href: 'https://x/liff' } })
    const { initLiff } = await import('@/app/liff/liff-sdk')
    expect(await initLiff('liff-1')).toEqual({ redirecting: true })
    expect(start).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('track', () => {
  it('does nothing without Clarity, and sends a fixed event name when it is loaded', () => {
    expect(() => track('task_saved')).not.toThrow()
    const clarity = vi.fn()
    vi.stubGlobal('window', { clarity })
    track('dashboard_tab_calendar')
    expect(clarity).toHaveBeenCalledWith('event', 'dashboard_tab_calendar')
    vi.unstubAllGlobals()
  })

  it('every track() call in the LIFF views uses a fixed name, never a value from the page', () => {
    const dir = join(__dirname, '..', 'src', 'app', 'liff')
    const calls = ['liff-app.tsx', 'dashboard-view.tsx', 'task-view.tsx', 'review-view.tsx', 'setup-view.tsx']
      .flatMap((f) => readFileSync(join(dir, f), 'utf8').match(/track\([^)]*\)/g) ?? [])
    expect(calls.length).toBeGreaterThanOrEqual(8)
    for (const c of calls) expect(c).toMatch(/^track\(('[a-z_]+'|`liff_\$\{params\.view\}_open`|`dashboard_tab_\$\{t\}`)\)$/)
  })
})

describe('privacy page', () => {
  it('says the LIFF pages are recorded, with text hidden and the LINE credentials removed', () => {
    const page = readFileSync(join(__dirname, '..', 'src', 'app', 'privacy', 'page.tsx'), 'utf8')
    expect(page).toContain('หน้าที่เปิดในแอป LINE (LIFF)')
    expect(page).toContain('ลบข้อมูลยืนยันตัวตนของ LINE ออกจากลิงก์ก่อนบันทึก')
    expect(page).not.toContain('ไม่บันทึกหน้าที่เปิดในแอป LINE')
  })
})
