import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.findQuotedFile (#33) against a small in-memory stand-in for the PostgREST
// builder: eq() filters, order() + limit() pick rows, maybeSingle() answers one row or null.

type Row = Record<string, string | null>
type Answer = { data: unknown; error: { code: string; message: string } | null }

function memoryDb(tables: { messages: Row[]; files: Row[] }) {
  let failTable: string | null = null
  const from = (table: string) => {
    if (table !== 'messages' && table !== 'files') throw new Error(`unexpected table ${table}`)
    const filters: ((r: Row) => boolean)[] = []
    const orders: { col: string; ascending: boolean }[] = []
    let columns: string[] = []
    let limit: number | null = null
    let single = false
    const run = (): Answer => {
      if (failTable === table) return { data: null, error: { code: '57014', message: 'canceled' } }
      let hit = tables[table].filter((r) => filters.every((f) => f(r)))
      hit = [...hit].sort((a, b) => {
        for (const o of orders) {
          const x = a[o.col] ?? ''
          const y = b[o.col] ?? ''
          if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1)
        }
        return 0
      })
      if (limit !== null) hit = hit.slice(0, limit)
      const shaped = hit.map((r) => Object.fromEntries(columns.map((c) => [c, r[c]])))
      if (single) {
        if (shaped.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } }
        return { data: shaped[0] ?? null, error: null }
      }
      return { data: shaped, error: null }
    }
    const q = {
      select(cols: string) { columns = cols.split(',').map((c) => c.trim()); return q },
      eq(c: string, v: string) { filters.push((r) => r[c] === v); return q },
      order(col: string, o: { ascending: boolean }) { orders.push({ col, ascending: o.ascending }); return q },
      limit(n: number) { limit = n; return q },
      maybeSingle() { single = true; return q },
      then(resolve: (a: Answer) => void) { resolve(run()) },
    }
    return q
  }
  const store = new SupabaseStore({ from } as unknown as SupabaseClient)
  return { store, failOn: (t: string) => { failTable = t } }
}

const messages: Row[] = [
  { id: 'msg-a', group_id: 'g1', line_message_id: 'm-file' },
  { id: 'msg-b', group_id: 'g1', line_message_id: 'm-text' },
  { id: 'msg-c', group_id: 'g2', line_message_id: 'm-other' },
]
const files: Row[] = [
  { id: 'f1', message_id: 'msg-a', file_name: 'old.pdf', drive_link: 'https://drive/old', saved_at: '2026-11-12T03:00:00Z' },
  { id: 'f2', message_id: 'msg-a', file_name: 'new.pdf', drive_link: 'https://drive/new', saved_at: '2026-11-12T04:00:00Z' },
  { id: 'f3', message_id: 'msg-c', file_name: 'secret.pdf', drive_link: 'https://drive/secret', saved_at: '2026-11-12T03:00:00Z' },
]

describe('SupabaseStore.findQuotedFile', () => {
  it('answers the newest file saved from the quoted message', async () => {
    const { store } = memoryDb({ messages, files })
    expect(await store.findQuotedFile('g1', 'm-file')).toEqual({ kind: 'file', fileName: 'new.pdf', driveLink: 'https://drive/new' })
  })

  it('answers no_file for a stored message with no files row', async () => {
    const { store } = memoryDb({ messages, files })
    expect(await store.findQuotedFile('g1', 'm-text')).toEqual({ kind: 'no_file' })
  })

  it('answers no_message for an unknown message and for another group\'s message', async () => {
    const { store } = memoryDb({ messages, files })
    expect(await store.findQuotedFile('g1', 'm-unknown')).toEqual({ kind: 'no_message' })
    expect(await store.findQuotedFile('g1', 'm-other')).toEqual({ kind: 'no_message' })
  })

  it('throws on a database error', async () => {
    const a = memoryDb({ messages, files })
    a.failOn('messages')
    await expect(a.store.findQuotedFile('g1', 'm-file')).rejects.toThrow()
    const b = memoryDb({ messages, files })
    b.failOn('files')
    await expect(b.store.findQuotedFile('g1', 'm-file')).rejects.toThrow()
  })
})
