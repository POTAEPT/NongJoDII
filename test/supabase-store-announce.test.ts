import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore's announce claim, confirm and release against a stand-in for the
// PostgREST query builder. Each from() starts a statement; every builder call is
// recorded on it, and awaiting the chain answers the next queued result.

type Call = { method: string; args: unknown[] }
type Statement = { table: string; calls: Call[] }
type Result = { data: unknown; error: { code: string } | null }

function stubDb(results: Result[]) {
  const statements: Statement[] = []
  let next = 0
  const chain = (st: Statement): unknown => new Proxy({}, {
    get: (_target, prop) => {
      const method = String(prop)
      if (method === 'then') {
        const result = results[next++] ?? { data: null, error: null }
        return (resolve: (r: Result) => void) => resolve(result)
      }
      return (...args: unknown[]) => {
        st.calls.push({ method, args })
        return chain(st)
      }
    },
  })
  const db = {
    from: (table: string) => {
      const st: Statement = { table, calls: [] }
      statements.push(st)
      return chain(st)
    },
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), statements }
}

const AT = new Date('2026-11-12T02:00:00Z')
const STALE = new Date('2026-11-12T01:58:00Z')
const TOKEN = '11111111-1111-4111-8111-111111111111'
const OLD = '22222222-2222-4222-8222-222222222222'
const ok = (data: unknown): Result => ({ data, error: null })

describe('SupabaseStore announce claims', () => {
  it('claim with no earlier token: one read, then the fresh update', async () => {
    const { store, statements } = stubDb([ok([]), ok([{ id: 'a' }, { id: 'b' }])])
    const got = await store.claimTaskAnnouncements({ taskIds: ['a', 'b'], token: TOKEN, at: AT, staleBefore: STALE })
    expect(got).toEqual([{ taskId: 'a', token: TOKEN }, { taskId: 'b', token: TOKEN }])
    expect(statements).toEqual([
      {
        table: 'tasks',
        calls: [
          { method: 'select', args: ['id, announce_pending_token'] },
          { method: 'in', args: ['id', ['a', 'b']] },
          { method: 'is', args: ['announced_at', null] },
          { method: 'is', args: ['deleted_at', null] },
          { method: 'not', args: ['announce_pending_token', 'is', null] },
        ],
      },
      {
        table: 'tasks',
        calls: [
          { method: 'update', args: [{ announce_pending_token: TOKEN, announce_pending_at: AT.toISOString() }] },
          { method: 'in', args: ['id', ['a', 'b']] },
          { method: 'is', args: ['announced_at', null] },
          { method: 'is', args: ['deleted_at', null] },
          { method: 'is', args: ['announce_pending_token', null] },
          { method: 'select', args: ['id'] },
        ],
      },
    ])
  })

  it('claim re-takes a released, then a stale batch by its token, before the fresh rows', async () => {
    const { store, statements } = stubDb([
      ok([{ id: 'a', announce_pending_token: OLD }, { id: 'c', announce_pending_token: OLD }]),
      ok([{ id: 'a', announce_pending_token: OLD }, { id: 'x', announce_pending_token: OLD }]),
      ok([]),
      ok([{ id: 'b' }]),
    ])
    const got = await store.claimTaskAnnouncements({ taskIds: ['a', 'b', 'c'], token: TOKEN, at: AT, staleBefore: STALE })
    expect(got).toEqual([{ taskId: 'a', token: OLD }, { taskId: 'x', token: OLD }, { taskId: 'b', token: TOKEN }])
    expect(statements).toHaveLength(4)
    const reclaim = (last: Call): Statement => ({
      table: 'tasks',
      calls: [
        { method: 'update', args: [{ announce_pending_at: AT.toISOString() }] },
        { method: 'in', args: ['announce_pending_token', [OLD]] },
        { method: 'is', args: ['announced_at', null] },
        { method: 'is', args: ['deleted_at', null] },
        last,
        { method: 'select', args: ['id, announce_pending_token'] },
      ],
    })
    expect(statements[1]).toEqual(reclaim({ method: 'is', args: ['announce_pending_at', null] }))
    expect(statements[2]).toEqual(reclaim({ method: 'lt', args: ['announce_pending_at', STALE.toISOString()] }))
    expect(statements[3].calls[0]).toEqual({
      method: 'update', args: [{ announce_pending_token: TOKEN, announce_pending_at: AT.toISOString() }],
    })
    expect(statements.flatMap((s) => s.calls).some((c) => c.method === 'or' || c.method === 'rpc')).toBe(false)
  })

  it('claim with no Task IDs sends nothing', async () => {
    const { store, statements } = stubDb([])
    expect(await store.claimTaskAnnouncements({ taskIds: [], token: TOKEN, at: AT, staleBefore: STALE })).toEqual([])
    expect(statements).toEqual([])
  })

  it('claim throws when a statement fails', async () => {
    const { store } = stubDb([ok([]), { data: null, error: { code: '40001' } }])
    await expect(store.claimTaskAnnouncements({ taskIds: ['a'], token: TOKEN, at: AT, staleBefore: STALE }))
      .rejects.toThrow('supabase claimTaskAnnouncements: 40001')
  })

  it('confirm sets announced_at and clears the claim of that token only', async () => {
    const { store, statements } = stubDb([ok(null)])
    await store.confirmTaskAnnouncements(TOKEN, AT)
    expect(statements).toEqual([{
      table: 'tasks',
      calls: [
        { method: 'update', args: [{ announced_at: AT.toISOString(), announce_pending_token: null, announce_pending_at: null }] },
        { method: 'eq', args: ['announce_pending_token', TOKEN] },
        { method: 'is', args: ['announced_at', null] },
      ],
    }])
  })

  it('release clears pending_at and keeps the token', async () => {
    const { store, statements } = stubDb([ok(null)])
    await store.releaseTaskAnnouncements(TOKEN)
    expect(statements).toEqual([{
      table: 'tasks',
      calls: [
        { method: 'update', args: [{ announce_pending_at: null }] },
        { method: 'eq', args: ['announce_pending_token', TOKEN] },
        { method: 'is', args: ['announced_at', null] },
      ],
    }])
  })

  it('confirm and release throw on an error', async () => {
    const { store } = stubDb([{ data: null, error: { code: 'X1' } }, { data: null, error: { code: 'X2' } }])
    await expect(store.confirmTaskAnnouncements(TOKEN, AT)).rejects.toThrow('supabase confirmTaskAnnouncements: X1')
    await expect(store.releaseTaskAnnouncements(TOKEN)).rejects.toThrow('supabase releaseTaskAnnouncements: X2')
  })
})
