import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@/server/log'
import { PAGE_SIZE, SupabaseStore } from '@/server/store/supabase-store'

// The #31 SupabaseStore methods against a stand-in for supabase-js: rpc() answers the next
// queued result; from() starts a chain that records its calls and answers the next queued
// result when awaited (or at .maybeSingle()).

type Call = { method: string; args: unknown[] }
type Result = { data: unknown; error: { code: string } | null }

function stubDb(results: Result[]) {
  const chains: Call[][] = []
  const rpcs: { fn: string; args: unknown }[] = []
  const next = () => Promise.resolve(results.shift() ?? { data: null, error: null })
  const db = {
    rpc: (fn: string, args: unknown) => {
      rpcs.push({ fn, args })
      return next()
    },
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
            return method === 'maybeSingle' ? { then } : builder
          }
        },
      })
      return builder
    },
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), chains, rpcs }
}

const ok = (data: unknown): Result => ({ data, error: null })
const fail = (code: string): Result => ({ data: null, error: { code } })

describe('SupabaseStore.changeProjectOwner', () => {
  it('calls change_project_owner', async () => {
    const { store, rpcs } = stubDb([ok(null)])
    expect(await store.changeProjectOwner('p1', 'Unew')).toEqual({ outcome: 'changed' })
    expect(rpcs).toEqual([{ fn: 'change_project_owner', args: { p_project_id: 'p1', p_new_owner: 'Unew' } }])
  })
  it('answers not_nominee on check_violation (the main group does not name them)', async () => {
    const { store } = stubDb([fail('23514')])
    expect(await store.changeProjectOwner('p1', 'Ux')).toEqual({ outcome: 'not_nominee' })
  })
  it('throws on any other error', async () => {
    const { store } = stubDb([fail('57014')])
    await expect(store.changeProjectOwner('p1', 'Ux')).rejects.toBeInstanceOf(AdapterError)
  })
})

describe('SupabaseStore.answerSubgroupTakeover', () => {
  it('calls answer_subgroup_takeover with the chosen ids', async () => {
    const { store, rpcs } = stubDb([ok(null)])
    expect(await store.answerSubgroupTakeover('p1', ['g1', 'g2'])).toEqual({ outcome: 'saved' })
    expect(rpcs).toEqual([{ fn: 'answer_subgroup_takeover', args: { p_project_id: 'p1', p_takeover_group_ids: ['g1', 'g2'] } }])
  })
  it.each(['23514', '40001'])('answers changed on %s (a Sub group stopped waiting)', async (code) => {
    const { store } = stubDb([fail(code)])
    expect(await store.answerSubgroupTakeover('p1', ['g1'])).toEqual({ outcome: 'changed' })
  })
  it('throws on any other error', async () => {
    const { store } = stubDb([fail('42501')])
    await expect(store.answerSubgroupTakeover('p1', [])).rejects.toBeInstanceOf(AdapterError)
  })
})

describe('SupabaseStore.getOwnerChange', () => {
  it('reads the Project and its groups a page at a time; waiting = Sub groups with takeover_asked_at', async () => {
    const { store, chains } = stubDb([
      ok({ id: 'p1', owner_line_user_id: 'Unew' }),
      ok([
        { id: 'g1', line_group_id: 'C1', name: 'หลัก', is_main: true, nominated_owner_line_user_id: 'Unew', owner_confirmed_at: '2026-11-12T03:00:00+00:00', takeover_asked_at: null },
        { id: 'g2', line_group_id: 'C2', name: null, is_main: false, nominated_owner_line_user_id: 'Uold', owner_confirmed_at: null, takeover_asked_at: '2026-11-12T03:00:00+00:00' },
        { id: 'g3', line_group_id: 'C3', name: 'ย่อย', is_main: false, nominated_owner_line_user_id: 'Unew', owner_confirmed_at: '2026-11-12T03:00:00+00:00', takeover_asked_at: null },
      ]),
    ])
    expect(await store.getOwnerChange('p1')).toEqual({
      projectId: 'p1', ownerLineUserId: 'Unew',
      mainGroup: { groupId: 'g1', lineGroupId: 'C1', name: 'หลัก', nominatedOwnerLineUserId: 'Unew', ownerConfirmedAt: new Date('2026-11-12T03:00:00Z') },
      waiting: [{ groupId: 'g2', lineGroupId: 'C2', name: null, askedAt: new Date('2026-11-12T03:00:00Z') }],
    })
    expect(chains[1]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['id, line_group_id, name, is_main, nominated_owner_line_user_id, owner_confirmed_at, takeover_asked_at'] },
      { method: 'eq', args: ['project_id', 'p1'] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
  })
  it('answers null for an unknown Project', async () => {
    const { store, chains } = stubDb([ok(null)])
    expect(await store.getOwnerChange('p1')).toBeNull()
    expect(chains).toHaveLength(1)
  })
})

describe('SupabaseStore.detachExpiredTakeovers', () => {
  it('is the one documented UPDATE: project_id and takeover_asked_at cleared together, returning the groups', async () => {
    const { store, chains } = stubDb([ok([{ id: 'g2', line_group_id: 'C2', name: null }])])
    const cutoff = new Date('2026-11-05T03:00:00Z')
    expect(await store.detachExpiredTakeovers(cutoff)).toEqual([{ groupId: 'g2', lineGroupId: 'C2', name: null }])
    expect(chains[0]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'update', args: [{ project_id: null, takeover_asked_at: null, drive_folder_id: null }] },
      { method: 'lt', args: ['takeover_asked_at', cutoff.toISOString()] },
      { method: 'select', args: ['id, line_group_id, name'] },
    ])
  })
})
