import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, SupabaseStore } from '@/server/store/supabase-store'

// #72 review follow-ups in SupabaseStore: the expired answer (NJ409 from
// answer_subgroup_takeover, 20261115150000) and the lost take-over card query. Same
// stand-in as supabase-store-owner-change.test.ts: rpc() and every awaited chain answer the
// next queued result; chains record their calls.

type Call = { method: string; args: unknown[] }
type Result = { data: unknown; error: { code: string } | null }

function stubDb(results: Result[]) {
  const chains: Call[][] = []
  const next = () => Promise.resolve(results.shift() ?? { data: null, error: null })
  const db = {
    rpc: () => next(),
    from: (table: string) => {
      const calls: Call[] = [{ method: 'from', args: [table] }]
      chains.push(calls)
      const then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => next().then(ok, bad)
      const builder: Record<string, unknown> = new Proxy({}, {
        get: (_t, prop) => {
          const method = String(prop)
          if (method === 'then') return then
          return (...args: unknown[]) => {
            calls.push({ method, args })
            return builder
          }
        },
      })
      return builder
    },
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), chains }
}

const ok = (data: unknown): Result => ({ data, error: null })

describe('SupabaseStore.answerSubgroupTakeover after 7 days', () => {
  it('answers expired on NJ409 (the SQL guard)', async () => {
    const { store } = stubDb([{ data: null, error: { code: 'NJ409' } }])
    expect(await store.answerSubgroupTakeover('p1', ['g1'])).toEqual({ outcome: 'expired' })
  })
})

describe('SupabaseStore.listUnsentTakeoverCards', () => {
  const after = new Date('2026-11-05T03:00:00Z')
  const asked = '2026-11-12T03:00:00+00:00'

  it('lists Projects with waiting Sub groups whose main group has no owner_takeover push since the ask', async () => {
    const { store, chains } = stubDb([
      ok([{ project_id: 'p1', takeover_asked_at: asked }, { project_id: 'p2', takeover_asked_at: asked }]),
      ok([{ project_id: 'p1', line_group_id: 'Cm1' }, { project_id: 'p2', line_group_id: 'Cm2' }]),
      // p2's card went out after the ask; an older push for p1 belongs to an earlier question.
      ok([{ line_target_id: 'Cm2', sent_at: '2026-11-12T03:00:05+00:00' }, { line_target_id: 'Cm1', sent_at: '2026-11-12T02:00:00+00:00' }]),
    ])
    expect(await store.listUnsentTakeoverCards(after)).toEqual(['p1'])
    expect(chains[0]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['project_id, takeover_asked_at'] },
      { method: 'gte', args: ['takeover_asked_at', after.toISOString()] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
    expect(chains[1]).toContainEqual({ method: 'eq', args: ['is_main', true] })
    expect(chains[1]).toContainEqual({ method: 'in', args: ['project_id', ['p1', 'p2']] })
    expect(chains[2]).toContainEqual({ method: 'eq', args: ['purpose', 'owner_takeover'] })
    expect(chains[2]).toContainEqual({ method: 'in', args: ['line_target_id', ['Cm1', 'Cm2']] })
    expect(chains[2]).toContainEqual({ method: 'gte', args: ['sent_at', new Date(asked).toISOString()] })
  })

  it('reads nothing more when no Sub group waits', async () => {
    const { store, chains } = stubDb([ok([])])
    expect(await store.listUnsentTakeoverCards(after)).toEqual([])
    expect(chains).toHaveLength(1)
  })
})
