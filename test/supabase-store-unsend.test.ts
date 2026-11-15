import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.deleteMessageByLineId (#24) against a small in-memory stand-in for the
// PostgREST builder: delete() + eq() remove the matching message rows, select() answers them.

type Row = { id: string; line_message_id: string }
type Answer = { data: unknown; error: { code: string; message: string } | null }

function memoryDb(rows: Row[]) {
  let failNext = false
  const from = (table: string) => {
    if (table !== 'messages') throw new Error(`unexpected table ${table}`)
    const filters: ((r: Row) => boolean)[] = []
    let deleting = false
    let columns: string[] | null = null
    const q = {
      delete() { deleting = true; return q },
      eq(c: string, v: string) { filters.push((r) => r[c as keyof Row] === v); return q },
      select(cols: string) { columns = cols.split(',').map((c) => c.trim()); return q },
      then(resolve: (a: Answer) => void) {
        if (failNext) {
          failNext = false
          return resolve({ data: null, error: { code: '57014', message: 'canceled' } })
        }
        const hit = rows.filter((r) => filters.every((f) => f(r)))
        if (deleting) for (const r of hit) rows.splice(rows.indexOf(r), 1)
        const cols = columns
        resolve({ data: cols === null ? null : hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c as keyof Row]]))), error: null })
      },
    }
    return q
  }
  const store = new SupabaseStore({ from } as unknown as SupabaseClient)
  return { store, failNext: () => { failNext = true } }
}

describe('SupabaseStore.deleteMessageByLineId', () => {
  it('deletes the row with that line_message_id and reports it', async () => {
    const rows: Row[] = [{ id: 'a', line_message_id: 'm-keep' }, { id: 'b', line_message_id: 'm-gone' }]
    const { store } = memoryDb(rows)
    expect(await store.deleteMessageByLineId('m-gone')).toEqual({ deleted: true })
    expect(rows).toEqual([{ id: 'a', line_message_id: 'm-keep' }])
  })

  it('answers deleted false for an unknown message, and again on a repeat', async () => {
    const rows: Row[] = [{ id: 'a', line_message_id: 'm-keep' }]
    const { store } = memoryDb(rows)
    expect(await store.deleteMessageByLineId('m-unknown')).toEqual({ deleted: false })
    expect(await store.deleteMessageByLineId('m-unknown')).toEqual({ deleted: false })
    expect(rows).toHaveLength(1)
  })

  it('throws on a database error', async () => {
    const { store, failNext } = memoryDb([{ id: 'b', line_message_id: 'm-gone' }])
    failNext()
    await expect(store.deleteMessageByLineId('m-gone')).rejects.toThrow()
  })
})
