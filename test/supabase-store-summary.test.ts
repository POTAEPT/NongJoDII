import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@/server/log'
import { SupabaseStore } from '@/server/store/supabase-store'

// #108 SupabaseStore methods (copied stand-in from supabase-store-drive.test.ts) against a stand-in for the PostgREST query builder. Each
// from() starts a chain that records its calls; awaiting the chain (or .maybeSingle())
// answers the next queued result.

type Call = { method: string; args: unknown[] }
type Result = { data: unknown; error: { code: string } | null }

function stubDb(results: Result[]) {
  const chains: Call[][] = []
  const db = {
    from: (table: string) => {
      const calls: Call[] = [{ method: 'from', args: [table] }]
      chains.push(calls)
      // Lazy: the result is taken when the chain is awaited, in await order.
      const then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(results.shift() ?? { data: null, error: null }).then(ok, bad)
      const builder: Record<string, unknown> = new Proxy({}, {
        get: (_t, prop) => {
          const method = String(prop)
          if (method === 'then') return then
          return (...args: unknown[]) => {
            calls.push({ method, args })
            return method === 'maybeSingle' ? { then } : builder
          }
        },
      })
      return builder
    },
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), chains }
}

const ok = (data: unknown): Result => ({ data, error: null })

describe('#108 Summary reads', () => {
  it('getLatestSummaryEnd reads the newest Summary of the group', async () => {
    const { store, chains } = stubDb([ok({ last_message_at: '2026-11-16T03:00:00+00:00' })])
    expect(await store.getLatestSummaryEnd('g1')).toEqual(new Date('2026-11-16T03:00:00Z'))
    expect(chains[0]).toEqual([
      { method: 'from', args: ['summaries'] },
      { method: 'select', args: ['last_message_at'] },
      { method: 'eq', args: ['group_id', 'g1'] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [1] },
      { method: 'maybeSingle', args: [] },
    ])
    expect(await stubDb([ok(null)]).store.getLatestSummaryEnd('g1')).toBeNull()
  })

  it('listTasksForSummary reads live open Tasks and recently done ones, newest first', async () => {
    const since = new Date('2026-10-17T00:00:00Z')
    const { store, chains } = stubDb([ok([])])
    expect(await store.listTasksForSummary('g1', since, 50)).toEqual([])
    const c = chains[0]
    expect(c).toContainEqual({ method: 'eq', args: ['group_id', 'g1'] })
    expect(c).toContainEqual({ method: 'is', args: ['deleted_at', null] })
    expect(c).toContainEqual({ method: 'or', args: [`status.neq.done,done_at.gte.${since.toISOString()},last_activity_at.gte.${since.toISOString()}`] })
    expect(c).toContainEqual({ method: 'order', args: ['created_at', { ascending: false }] })
    expect(c).toContainEqual({ method: 'limit', args: [50] })
  })

  it('throws an AdapterError on a database error', async () => {
    await expect(stubDb([{ data: null, error: { code: 'XX000' } }]).store.getLatestSummaryEnd('g1')).rejects.toBeInstanceOf(AdapterError)
  })
})
