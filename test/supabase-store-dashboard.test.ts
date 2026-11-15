import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_PAGE, SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.listDashboardMemberships against a stand-in for the PostgREST query builder:
// every filter call returns the builder, and .range() answers one page (as in
// supabase-store-weekly.test.ts).

type Call = { method: string; args: unknown[] }

function stubDb(pages: Record<string, unknown>[][]) {
  const calls: Call[] = []
  let page = 0
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_target, prop) => {
      const method = String(prop)
      if (method === 'then') return undefined
      return (...args: unknown[]) => {
        calls.push({ method, args })
        if (method === 'range') return Promise.resolve({ data: pages[page++] ?? [], error: null })
        return builder
      }
    },
  })
  const db = { from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder } }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
}

const row = (i: number, left: boolean) => ({
  group_id: `g-${String(i).padStart(5, '0')}`, is_pm: true, left_at: left ? '2026-11-14T00:00:00Z' : null,
  groups: { project_id: 'p1', projects: { owner_line_user_id: 'Uowner' } },
})

describe('SupabaseStore.listDashboardMemberships', () => {
  it('reads every page, so a left membership past the first page is still seen', async () => {
    const first = Array.from({ length: DASHBOARD_PAGE }, (_, i) => row(i, false))
    const { store, calls } = stubDb([first, [row(DASHBOARD_PAGE, true)]])
    const memberships = await store.listDashboardMemberships('Upm')
    expect(memberships).toHaveLength(DASHBOARD_PAGE + 1)
    expect(memberships.at(-1)).toEqual({
      groupId: `g-0${DASHBOARD_PAGE}`, projectId: 'p1', projectOwnerLineUserId: 'Uowner', isPm: true, left: true,
    })
    expect(calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
      [0, DASHBOARD_PAGE - 1], [DASHBOARD_PAGE, 2 * DASHBOARD_PAGE - 1],
    ])
    expect(calls).toContainEqual({ method: 'order', args: ['group_id', { ascending: true }] })
  })

  it('stops after one short page', async () => {
    const { store, calls } = stubDb([[row(1, false), row(2, true)]])
    expect(await store.listDashboardMemberships('Upm')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'range')).toHaveLength(1)
  })
})
