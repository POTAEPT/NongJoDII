const VIEWS = ['google', 'review', 'task', 'progress', 'dashboard', 'setup', 'owner'] as const

export type LiffParams = { view: (typeof VIEWS)[number] | null; id: string | null }

function pick(p: URLSearchParams): LiffParams {
  const view = p.get('view')
  const known = VIEWS.find((v) => v === view) ?? null
  return known ? { view: known, id: p.get('id') } : { view: null, id: null }
}

export function readLiffParams(search: string): LiffParams {
  const direct = new URLSearchParams(search)
  if (direct.has('view') || direct.has('id')) return pick(direct)
  const state = direct.get('liff.state')
  if (!state) return { view: null, id: null }
  const q = state.indexOf('?')
  return pick(new URLSearchParams(q === -1 ? '' : state.slice(q + 1)))
}
