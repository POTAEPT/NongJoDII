'use client'

// #19 Clarity on the LIFF pages, for the usage funnel (course evidence).
//
// LINE's guide ("Developing a LIFF app"): never send the primary redirect URL to a logging
// tool, because it carries the user's access_token. From LIFF v2.11.0 liff.init() removes the
// credentials from the URL when it resolves, and LINE suggests sending page views after it.
// So Clarity loads only from startAnalytics(), which initLiff calls after init resolved
// (liff-sdk.ts). Before loading, any credential still in the URL is stripped as a second
// guard. The global tag in src/app/clarity.tsx keeps skipping /liff, so nothing loads early.
//
// No personal data (.greptile/rules.md): events are fixed names, never titles, names or chat
// text; <body data-clarity-mask="True"> masks all page text; URLs keep IDs only.

const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_ID

/** URL parameters that can carry LINE credentials or a login round trip. Our own (view, id)
 *  are never in this list. */
export const CREDENTIAL_PARAMS = [
  'access_token', 'id_token', 'code', 'state', 'liffClientId', 'liffRedirectUri', 'context_token', 'feature_token',
] as const

/** The search and hash with every credential parameter removed. `changed` says whether any was. */
export function withoutCredentials(search: string, hash: string): { search: string; hash: string; changed: boolean } {
  let changed = false
  const clean = (raw: string, prefix: '?' | '#'): string => {
    const body = raw.startsWith(prefix) ? raw.slice(1) : raw
    if (body === '' || !body.includes('=')) return raw
    const params = new URLSearchParams(body)
    for (const p of CREDENTIAL_PARAMS) {
      if (params.has(p)) {
        params.delete(p)
        changed = true
      }
    }
    const rest = params.toString()
    return rest === '' ? '' : `${prefix}${rest}`
  }
  const search2 = clean(search, '?')
  const hash2 = clean(hash, '#')
  return { search: changed ? search2 : search, hash: changed ? hash2 : hash, changed }
}

/** What startAnalytics touches, so tests can pass a stand-in. */
export type AnalyticsWindow = {
  location: { pathname: string; search: string; hash: string }
  history: { replaceState(data: unknown, unused: string, url: string): void }
  document: { createElement(tag: 'script'): { async: boolean; src: string; id: string }; head: { appendChild(node: unknown): unknown }; getElementById(id: string): unknown }
  clarity?: ClarityFn
}

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] }

const SCRIPT_ID = 'ms-clarity-liff'

/** Strips credentials from the URL, then loads Clarity once. Production builds with a
 *  project ID only (as src/app/clarity.tsx). Call only after liff.init() resolved. */
export function startAnalytics(
  w: AnalyticsWindow = window as unknown as AnalyticsWindow,
  cfg: { id: string | undefined; enabled: boolean } = { id: CLARITY_ID, enabled: process.env.NODE_ENV === 'production' },
): boolean {
  const { search, hash, changed } = withoutCredentials(w.location.search, w.location.hash)
  if (changed) w.history.replaceState(null, '', `${w.location.pathname}${search}${hash}`)
  if (!cfg.enabled || !cfg.id) return false
  if (w.document.getElementById(SCRIPT_ID)) return true
  // The standard Clarity snippet: a queue until the tag loads.
  const q: ClarityFn = w.clarity ?? Object.assign((...args: unknown[]) => { (q.q = q.q ?? []).push(args) }, {})
  w.clarity = q
  const s = w.document.createElement('script')
  s.async = true
  s.id = SCRIPT_ID
  s.src = `https://www.clarity.ms/tag/${encodeURIComponent(cfg.id)}`
  w.document.head.appendChild(s)
  return true
}

/** The funnel events. Fixed names only. */
export type AnalyticsEvent =
  | `liff_${string}_open`
  | 'dashboard_tab_overview' | 'dashboard_tab_calendar' | 'dashboard_tab_tasks'
  | 'dashboard_compare_open_group' | 'dashboard_member_open' | 'dashboard_task_open'
  | 'task_saved' | 'task_reopened' | 'review_confirmed' | 'setup_submitted'

/** Sends one Clarity custom event. Does nothing when Clarity is not loaded (dev, tests). */
export function track(event: AnalyticsEvent): void {
  if (typeof window === 'undefined') return
  const c = (window as unknown as { clarity?: ClarityFn }).clarity
  if (typeof c === 'function') c('event', event)
}
