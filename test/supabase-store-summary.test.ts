import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
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
    // #109: an rpc answers the next queued result too.
    rpc: (name: string, args: unknown) => {
      chains.push([{ method: 'rpc', args: [name, args] }])
      return { then: (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(results.shift() ?? { data: null, error: null }).then(ok, bad) }
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

describe('#109 tags in the store', () => {
  const task = {
    groupId: 'g1', candidateId: 'c1', title: 't', details: null, status: 'not_assigned' as const,
    assigneeLineUserId: null, createdByLineUserId: 'U1', dueAt: null, tags: ['ออกแบบ'],
  }

  it('confirmCandidate sets the tags on a created Task in a second statement', async () => {
    const { store, chains } = stubDb([ok([{ outcome: 'created', task_id: 't1' }]), ok(null)])
    expect(await store.confirmCandidate(task, new Date())).toEqual({ outcome: 'created', taskId: 't1' })
    expect(chains[1]).toEqual([
      { method: 'from', args: ['tasks'] },
      { method: 'update', args: [{ tags: ['ออกแบบ'] }] },
      { method: 'eq', args: ['id', 't1'] },
    ])
  })

  it('a failed tag write is logged and never fails the confirm; no tags or already decided writes nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = stubDb([ok([{ outcome: 'created', task_id: 't1' }]), { data: null, error: { code: '23514' } }])
    expect(await failed.store.confirmCandidate(task, new Date())).toEqual({ outcome: 'created', taskId: 't1' })
    expect(errors.mock.calls.map((c) => String(c[0])).join()).toContain('task_tags_failed')
    const none = stubDb([ok([{ outcome: 'created', task_id: 't1' }])])
    await none.store.confirmCandidate({ ...task, tags: [] }, new Date())
    expect(none.chains).toHaveLength(1)
    const decided = stubDb([ok([{ outcome: 'already_decided', task_id: 't1' }])])
    await decided.store.confirmCandidate(task, new Date())
    expect(decided.chains).toHaveLength(1)
    errors.mockRestore()
  })

  it('updateTask writes the tags, and listDashboardTasks reads them', async () => {
    const { store, chains } = stubDb([ok([{ id: 't1' }]), ok([])])
    await store.updateTask('t1', {
      title: 't', details: null, assigneeLineUserId: null, status: 'not_assigned', dueAt: null,
      lastEditedByLineUserId: 'U1', lastActivityAt: new Date('2026-11-16T00:00:00Z'), tags: ['ด่วน'],
    })
    expect(chains[0][1]).toMatchObject({ method: 'update', args: [expect.objectContaining({ tags: ['ด่วน'] })] })
    await store.listDashboardTasks(['g1'])
    expect(chains[1]).toContainEqual({ method: 'select', args: [expect.stringContaining(' tags,')] })
  })
})
