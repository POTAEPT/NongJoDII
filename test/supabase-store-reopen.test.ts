import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.reopenTask (#139): one UPDATE whose WHERE holds the precondition (live, Done,
// assignee unchanged since the read), so a Task moved in between is left alone.

function builderDb(answer: { data: unknown; error: { code: string; message: string } | null }) {
  const calls: unknown[][] = []
  const chain: Record<string, (...a: unknown[]) => unknown> = {}
  for (const m of ['from', 'update', 'eq', 'is']) chain[m] = (...a: unknown[]) => { calls.push([m, ...a]); return chain }
  chain.select = (...a: unknown[]) => { calls.push(['select', ...a]); return Promise.resolve(answer) }
  return { store: new SupabaseStore(chain as unknown as SupabaseClient), calls }
}

const AT = new Date('2026-11-17T03:00:00Z')

describe('SupabaseStore.reopenTask', () => {
  it('reopens a Done Task held by the same assignee, clearing done_at', async () => {
    const { store, calls } = builderDb({ data: [{ id: 't1' }], error: null })
    const res = await store.reopenTask({ taskId: 't1', assignee: 'Upim', toStatus: 'in_process', by: 'Upim', at: AT })
    expect(res).toEqual({ updated: true })
    expect(calls).toEqual([
      ['from', 'tasks'],
      ['update', { status: 'in_process', done_at: null, last_activity_at: AT.toISOString(), last_edited_by_line_user_id: 'Upim' }],
      ['eq', 'id', 't1'],
      ['is', 'deleted_at', null],
      ['eq', 'status', 'done'],
      ['eq', 'assignee_line_user_id', 'Upim'],
      ['select', 'id'],
    ])
  })

  it('a Task with no assignee must still have none', async () => {
    const { store, calls } = builderDb({ data: [], error: null })
    const res = await store.reopenTask({ taskId: 't1', assignee: null, toStatus: 'not_assigned', by: 'Ubank', at: AT })
    expect(res).toEqual({ updated: false })
    expect(calls).toContainEqual(['is', 'assignee_line_user_id', null])
  })

  it('throws on a database error', async () => {
    const { store } = builderDb({ data: null, error: { code: '57014', message: 'canceled' } })
    await expect(store.reopenTask({ taskId: 't1', assignee: null, toStatus: 'not_assigned', by: 'U', at: AT })).rejects.toThrow()
  })
})
