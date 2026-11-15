import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.unsendMessage (#24): one call to rpc unsend_message, which writes the
// tombstone and deletes the stored copy in one transaction (migration
// 20261115140000_unsent_messages.sql). The SQL itself was run against Postgres.

function rpcDb(answer: { data: unknown; error: { code: string; message: string } | null }) {
  const calls: { fn: string; args: unknown }[] = []
  const db = { rpc: (fn: string, args: unknown) => { calls.push({ fn, args }); return Promise.resolve(answer) } }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
}

describe('SupabaseStore.unsendMessage', () => {
  it('calls unsend_message with the LINE message ID and reports a deleted copy', async () => {
    const { store, calls } = rpcDb({ data: true, error: null })
    expect(await store.unsendMessage('m-gone')).toEqual({ deleted: true })
    expect(calls).toEqual([{ fn: 'unsend_message', args: { p_line_message_id: 'm-gone' } }])
  })

  it('answers deleted false when no copy was stored', async () => {
    const { store } = rpcDb({ data: false, error: null })
    expect(await store.unsendMessage('m-unknown')).toEqual({ deleted: false })
  })

  it('throws on a database error', async () => {
    const { store } = rpcDb({ data: null, error: { code: '57014', message: 'canceled' } })
    await expect(store.unsendMessage('m-gone')).rejects.toThrow()
  })
})
