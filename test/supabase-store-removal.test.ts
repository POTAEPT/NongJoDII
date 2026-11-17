import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore's #11 methods against a stand-in that records each PostgREST query (table,
// operation, payload, filters) and answers from a queue. The predicates carry the rules:
// a mark never moves, a stale leave is ignored, and the purge's DELETE itself checks the
// delete date, so a group re-invited since it was listed stays.

type Query = { table: string; op: string; payload?: unknown; filters: string[]; order: string[]; limit?: number }

function recordingDb(answers: unknown[] = []) {
  const queries: Query[] = []
  const from = (table: string) => {
    const q: Query = { table, op: 'select', filters: [], order: [] }
    queries.push(q)
    const b = {
      select(cols: string) { if (q.op === 'select') q.payload = cols; return b },
      update(v: unknown) { q.op = 'update'; q.payload = v; return b },
      delete() { q.op = 'delete'; return b },
      eq(c: string, v: unknown) { q.filters.push(`${c}=eq.${String(v)}`); return b },
      is(c: string, v: unknown) { q.filters.push(`${c}=is.${String(v)}`); return b },
      lt(c: string, v: unknown) { q.filters.push(`${c}=lt.${String(v)}`); return b },
      lte(c: string, v: unknown) { q.filters.push(`${c}=lte.${String(v)}`); return b },
      or(f: string) { q.filters.push(`or=${f}`); return b },
      order(c: string) { q.order.push(c); return b },
      limit(n: number) { q.limit = n; return b },
      maybeSingle() { return b },
      then(resolve: (a: { data: unknown; error: null }) => void) {
        resolve({ data: answers.length > 0 ? answers.shift() : null, error: null })
      },
    }
    return b
  }
  return { store: new SupabaseStore({ from } as unknown as SupabaseClient), queries }
}

const AT = new Date('2026-11-12T03:00:00.000Z')
const ISO = AT.toISOString()

describe('SupabaseStore #11 removal', () => {
  it('markBotLeft writes only an unmarked group, only for a leave newer than the latest join, then reads the date', async () => {
    const { store, queries } = recordingDb([null, { delete_after: '2026-11-19T03:00:00.000Z' }])
    expect(await store.markBotLeft({ lineGroupId: 'C1', at: AT })).toEqual({ deleteAfter: new Date('2026-11-19T03:00:00.000Z') })
    expect(queries[0]).toMatchObject({
      table: 'groups', op: 'update',
      payload: { left_at: ISO, delete_after: '2026-11-19T03:00:00.000Z' },
      // A row no join was applied to yet (joined_at null) takes any leave.
      filters: ['line_group_id=eq.C1', 'left_at=is.null', `or=joined_at.is.null,joined_at.lte."${ISO}"`],
    })
    expect(queries[1]).toMatchObject({ table: 'groups', op: 'select', filters: ['line_group_id=eq.C1'] })
  })

  it('markBotLeft answers null for a group never stored', async () => {
    const { store } = recordingDb([null, null])
    expect(await store.markBotLeft({ lineGroupId: 'C1', at: AT })).toEqual({ deleteAfter: null })
  })

  it('markBotJoined restarts the Owner count first, then moves joined_at, then clears an older mark', async () => {
    const { store, queries } = recordingDb()
    await store.markBotJoined({ groupId: 'g1', at: AT })
    expect(queries.map((q) => ({ op: q.op, payload: q.payload, filters: q.filters }))).toEqual([
      { op: 'update', payload: { owner_left_at: ISO }, filters: ['id=eq.g1', 'owner_confirmed_at=is.null', `owner_left_at=lt.${ISO}`] },
      // The row's first join sets joined_at (null until then); later ones move it forward.
      { op: 'update', payload: { joined_at: ISO }, filters: ['id=eq.g1', `or=joined_at.is.null,joined_at.lt."${ISO}"`] },
      { op: 'update', payload: { left_at: null, delete_after: null }, filters: ['id=eq.g1', `left_at=lte.${ISO}`] },
    ])
  })

  it('listPurgeDueGroups lists past-due groups, oldest date first, up to the limit', async () => {
    const { store, queries } = recordingDb([[{ id: 'g1' }, { id: 'g2' }]])
    expect(await store.listPurgeDueGroups(AT, 50)).toEqual(['g1', 'g2'])
    expect(queries[0]).toMatchObject({ table: 'groups', op: 'select', filters: [`delete_after=lte.${ISO}`], order: ['delete_after', 'id'], limit: 50 })
  })

  it('purgeGroup calls rpc purge_group and keeps only detached groups the bot is still in (#77)', async () => {
    const calls: { fn: string; args: unknown }[] = []
    const answer = {
      purged: true, project_deleted: false,
      detached: [
        { id: 's1', line_group_id: 'Cs1', name: 'ทีม Dev', bot_in: true },
        { id: 's2', line_group_id: 'Cs2', name: null, bot_in: false },
      ],
    }
    const db = { rpc: (fn: string, args: unknown) => { calls.push({ fn, args }); return Promise.resolve({ data: answer, error: null }) } }
    const store = new SupabaseStore(db as unknown as SupabaseClient)
    expect(await store.purgeGroup('g1', AT)).toEqual({
      purged: true, projectDeleted: false, detached: [{ groupId: 's1', lineGroupId: 'Cs1', name: 'ทีม Dev' }],
    })
    expect(calls).toEqual([{ fn: 'purge_group', args: { p_group_id: 'g1', p_now: ISO } }])
  })

  it('purgeGroup answers not purged, and throws on an error or an unexpected answer', async () => {
    const answer = (data: unknown, error: unknown = null) =>
      new SupabaseStore({ rpc: () => Promise.resolve({ data, error }) } as unknown as SupabaseClient)
    expect(await answer({ purged: false, project_deleted: false, detached: [] }).purgeGroup('g1', AT))
      .toEqual({ purged: false, projectDeleted: false, detached: [] })
    await expect(answer(null, { code: '57014', message: 'x' }).purgeGroup('g1', AT)).rejects.toThrow()
    await expect(answer('weird').purgeGroup('g1', AT)).rejects.toThrow()
  })
})
