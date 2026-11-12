import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore's announce claim, confirm, release and abandon against a small
// in-memory stand-in for the PostgREST builder. It applies the filters the store
// uses to an array of task rows, so the tests assert stored rows and results.

type Row = {
  id: string; announced_at: string | null; deleted_at: string | null
  announce_pending_token: string | null; announce_pending_at: string | null
}
type Value = string | null
type Answer = { data: unknown; error: { code: string } | null }

function memoryDb(rows: Row[]) {
  let failNext: string | null = null
  const from = (table: string) => {
    if (table !== 'tasks') throw new Error(`unexpected table ${table}`)
    const filters: ((r: Row) => boolean)[] = []
    let patch: Partial<Row> | null = null
    let columns: string[] | null = null
    const col = (r: Row, c: string) => r[c as keyof Row]
    const q = {
      select(cols: string) { columns = cols.split(',').map((c) => c.trim()); return q },
      update(p: Partial<Row>) { patch = p; return q },
      eq(c: string, v: Value) { filters.push((r) => col(r, c) === v); return q },
      in(c: string, vs: Value[]) { filters.push((r) => vs.includes(col(r, c))); return q },
      is(c: string, v: null) { filters.push((r) => col(r, c) === v); return q },
      not(c: string, _op: 'is', v: null) { filters.push((r) => col(r, c) !== v); return q },
      // Every timestamp here is a toISOString() value, so string order is time order.
      lt(c: string, v: string) {
        filters.push((r) => { const x = col(r, c); return x !== null && x < v })
        return q
      },
      then(resolve: (a: Answer) => void) {
        if (failNext !== null) {
          const code = failNext
          failNext = null
          return resolve({ data: null, error: { code } })
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (patch) for (const r of hit) Object.assign(r, patch)
        const cols = columns
        resolve({ data: cols === null ? null : hit.map((r) => Object.fromEntries(cols.map((c) => [c, col(r, c)]))), error: null })
      },
    }
    return q
  }
  const store = new SupabaseStore({ from } as unknown as SupabaseClient)
  return { store, failNext: (code: string) => { failNext = code } }
}

const T0 = new Date('2026-11-12T02:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const WINDOW = 2 * 60_000
const NEW = '11111111-1111-4111-8111-111111111111'
const OLD = '22222222-2222-4222-8222-222222222222'

function row(id: string, p: Partial<Row> = {}): Row {
  return { id, announced_at: null, deleted_at: null, announce_pending_token: null, announce_pending_at: null, ...p }
}
const claimAt = (store: SupabaseStore, taskIds: string[], when: Date, token = NEW) =>
  store.claimTaskAnnouncements({ taskIds, token, at: when, staleBefore: new Date(when.getTime() - WINDOW) })

describe('SupabaseStore announce claims', () => {
  it('a fresh claim sets the token and pending_at', async () => {
    const rows = [row('a'), row('b')]
    const { store } = memoryDb(rows)
    expect(await claimAt(store, ['a', 'b'], T0)).toEqual([{ taskId: 'a', token: NEW }, { taskId: 'b', token: NEW }])
    expect(rows).toEqual([
      row('a', { announce_pending_token: NEW, announce_pending_at: T0.toISOString() }),
      row('b', { announce_pending_token: NEW, announce_pending_at: T0.toISOString() }),
    ])
  })

  it('a live claim is left alone', async () => {
    const rows = [row('a', { announce_pending_token: OLD, announce_pending_at: T0.toISOString() })]
    const { store } = memoryDb(rows)
    expect(await claimAt(store, ['a'], at(60_000))).toEqual([])
    expect(rows).toEqual([row('a', { announce_pending_token: OLD, announce_pending_at: T0.toISOString() })])
  })

  it('a released batch is re-claimed whole with its token, including a row not asked for', async () => {
    const rows = [row('a', { announce_pending_token: OLD }), row('x', { announce_pending_token: OLD }), row('b')]
    const { store } = memoryDb(rows)
    const now = at(10_000)
    expect(await claimAt(store, ['a', 'b'], now)).toEqual([
      { taskId: 'a', token: OLD }, { taskId: 'x', token: OLD }, { taskId: 'b', token: NEW },
    ])
    expect(rows.map((r) => [r.announce_pending_token, r.announce_pending_at])).toEqual([
      [OLD, now.toISOString()], [OLD, now.toISOString()], [NEW, now.toISOString()],
    ])
  })

  it('a stale batch is re-claimed with its token', async () => {
    const rows = [row('a', { announce_pending_token: OLD, announce_pending_at: T0.toISOString() })]
    const { store } = memoryDb(rows)
    const now = at(WINDOW + 1000)
    expect(await claimAt(store, ['a'], now)).toEqual([{ taskId: 'a', token: OLD }])
    expect(rows[0]).toEqual(row('a', { announce_pending_token: OLD, announce_pending_at: now.toISOString() }))
  })

  it('announced and deleted rows are left alone', async () => {
    const rows = [
      row('done', { announced_at: T0.toISOString() }),
      row('gone', { deleted_at: T0.toISOString(), announce_pending_token: OLD }),
    ]
    const { store } = memoryDb(rows)
    expect(await claimAt(store, ['done', 'gone'], at(2 * WINDOW))).toEqual([])
    expect(rows).toEqual([
      row('done', { announced_at: T0.toISOString() }),
      row('gone', { deleted_at: T0.toISOString(), announce_pending_token: OLD }),
    ])
  })

  it('confirm sets announced_at and clears the claim of that token only', async () => {
    const rows = [row('a'), row('b')]
    const { store } = memoryDb(rows)
    await claimAt(store, ['a'], T0)
    await claimAt(store, ['b'], T0, OLD)
    await store.confirmTaskAnnouncements(NEW, at(5000))
    expect(rows).toEqual([
      row('a', { announced_at: at(5000).toISOString() }),
      row('b', { announce_pending_token: OLD, announce_pending_at: T0.toISOString() }),
    ])
  })

  it('release keeps the token and clears pending_at, only for the matching claim time', async () => {
    const rows = [row('a')]
    const { store } = memoryDb(rows)
    await claimAt(store, ['a'], T0)
    await store.releaseTaskAnnouncements(NEW, at(1))
    expect(rows[0].announce_pending_at).toBe(T0.toISOString())
    await store.releaseTaskAnnouncements(NEW, T0)
    expect(rows[0]).toEqual(row('a', { announce_pending_token: NEW }))
  })

  it('abandon clears the token and pending_at, only for the matching claim time', async () => {
    const rows = [row('a')]
    const { store } = memoryDb(rows)
    await claimAt(store, ['a'], T0)
    await store.abandonTaskAnnouncements(NEW, at(1))
    expect(rows[0].announce_pending_token).toBe(NEW)
    await store.abandonTaskAnnouncements(NEW, T0)
    expect(rows[0]).toEqual(row('a'))
  })

  it('a claim with no Task IDs claims nothing', async () => {
    const rows = [row('a')]
    const { store } = memoryDb(rows)
    expect(await claimAt(store, [], T0)).toEqual([])
    expect(rows).toEqual([row('a')])
  })

  it('client errors propagate', async () => {
    const { store, failNext } = memoryDb([row('a')])
    failNext('40001')
    await expect(claimAt(store, ['a'], T0)).rejects.toThrow('supabase claimTaskAnnouncements: 40001')
    failNext('X1')
    await expect(store.confirmTaskAnnouncements(NEW, T0)).rejects.toThrow('supabase confirmTaskAnnouncements: X1')
    failNext('X2')
    await expect(store.releaseTaskAnnouncements(NEW, T0)).rejects.toThrow('supabase releaseTaskAnnouncements: X2')
    failNext('X3')
    await expect(store.abandonTaskAnnouncements(NEW, T0)).rejects.toThrow('supabase abandonTaskAnnouncements: X3')
  })
})
