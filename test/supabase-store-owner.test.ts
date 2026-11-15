import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// #30 SupabaseStore methods against a stand-in for the PostgREST query builder. Every
// filter call returns the builder; each awaited query (and each rpc) takes the next answer
// from `answers`, in order.

type Call = { method: string; args: unknown[] }
type Answer = { data: unknown; error: { code: string } | null }

function stubDb(answers: Answer[]) {
  const calls: Call[] = []
  const next = () => answers.shift() ?? { data: null, error: null }
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_target, prop) => {
      const method = String(prop)
      if (method === 'then') {
        return (resolve: (a: Answer) => void) => resolve(next())
      }
      return (...args: unknown[]) => {
        calls.push({ method, args })
        return builder
      }
    },
  })
  const db = {
    from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder },
    rpc: (name: string, args: unknown) => { calls.push({ method: 'rpc', args: [name, args] }); return Promise.resolve(next()) },
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
}

const AT = new Date('2026-11-13T03:00:00Z')
const PENDING = {
  is_main: true, project_id: 'p1', nominated_owner_line_user_id: 'Uold', owner_confirmed_at: null,
  owner_left_at: '2026-11-12T03:00:00+00:00', left_at: null,
}

describe('SupabaseStore.markOwnerLeft', () => {
  it('sets owner_left_at only on the group whose confirmed Owner is the leaver', async () => {
    const { store, calls } = stubDb([{ data: [{ id: 'g1' }], error: null }])
    expect(await store.markOwnerLeft({ groupId: 'g1', lineUserId: 'Uold', at: AT })).toEqual({ updated: true })
    expect(calls).toContainEqual({ method: 'update', args: [{ owner_left_at: AT.toISOString() }] })
    expect(calls).toContainEqual({ method: 'eq', args: ['nominated_owner_line_user_id', 'Uold'] })
    expect(calls).toContainEqual({ method: 'not', args: ['owner_confirmed_at', 'is', null] })
  })

  it('answers updated false when no row matched', async () => {
    const { store } = stubDb([{ data: [], error: null }])
    expect(await store.markOwnerLeft({ groupId: 'g1', lineUserId: 'Uold', at: AT })).toEqual({ updated: false })
  })
})

describe('SupabaseStore.openOwnerNeededPrompt', () => {
  it('inserts an owner_needed card with no Task', async () => {
    const { store, calls } = stubDb([{ data: { id: 'pr1' }, error: null }])
    expect(await store.openOwnerNeededPrompt({ groupId: 'g1', subjectLineUserId: 'Uold', askedAt: AT })).toEqual({ promptId: 'pr1' })
    expect(calls).toContainEqual({ method: 'from', args: ['task_prompts'] })
    expect(calls).toContainEqual({
      method: 'insert',
      args: [{ group_id: 'g1', kind: 'owner_needed', subject_line_user_id: 'Uold', asked_at: AT.toISOString() }],
    })
  })

  it('answers null when the group already has an open card (23505)', async () => {
    const { store } = stubDb([{ data: null, error: { code: '23505' } }])
    expect(await store.openOwnerNeededPrompt({ groupId: 'g1', subjectLineUserId: 'Uold', askedAt: AT })).toEqual({ promptId: null })
  })
})

describe('SupabaseStore.claimOwnerChange', () => {
  it('claims with a compare-and-set on the nominee it read, once the old Owner has left', async () => {
    const { store, calls } = stubDb([
      { data: PENDING, error: null },
      { data: { left_at: '2026-11-12T03:00:00+00:00' }, error: null }, // the old Owner's membership
      { data: [{ id: 'g1' }], error: null },
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'claimed' })
    expect(calls).toContainEqual({
      method: 'update',
      args: [{ nominated_owner_line_user_id: 'Unew', owner_nominated_by_line_user_id: 'Unew', owner_nominated_at: AT.toISOString() }],
    })
    expect(calls).toContainEqual({ method: 'eq', args: ['nominated_owner_line_user_id', 'Uold'] })
    expect(calls).toContainEqual({ method: 'is', args: ['owner_confirmed_at', null] })
  })

  it('answers taken when the nominee is a live Member, and writes nothing', async () => {
    const { store, calls } = stubDb([
      { data: { ...PENDING, nominated_owner_line_user_id: 'Uother' }, error: null },
      { data: { left_at: null }, error: null },
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'taken' })
    expect(calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('answers taken when another press changed the nominee first', async () => {
    const { store } = stubDb([
      { data: PENDING, error: null },
      { data: { left_at: '2026-11-12T03:00:00+00:00' }, error: null },
      { data: [], error: null },
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'taken' })
  })

  it('tells a Sub group and a group with no pending change apart', async () => {
    expect(await stubDb([{ data: { ...PENDING, is_main: false }, error: null }]).store.claimOwnerChange('g1', 'Unew', AT))
      .toEqual({ outcome: 'not_main_group' })
    expect(await stubDb([{ data: { ...PENDING, owner_left_at: null }, error: null }]).store.claimOwnerChange('g1', 'Unew', AT))
      .toEqual({ outcome: 'not_pending' })
    expect(await stubDb([{ data: { ...PENDING, nominated_owner_line_user_id: 'Unew' }, error: null }]).store.claimOwnerChange('g1', 'Unew', AT))
      .toEqual({ outcome: 'already_claimed' })
  })
})

describe('SupabaseStore.completeOwnerChange', () => {
  it('calls complete_owner_change and passes its outcome through', async () => {
    const { store, calls } = stubDb([{ data: 'needs_drive', error: null }])
    expect(await store.completeOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'needs_drive' })
    expect(calls).toContainEqual({
      method: 'rpc', args: ['complete_owner_change', { p_group_id: 'g1', p_line_user_id: 'Unew', p_at: AT.toISOString() }],
    })
  })

  it('throws on an outcome it does not know', async () => {
    await expect(stubDb([{ data: 'what', error: null }]).store.completeOwnerChange('g1', 'Unew', AT)).rejects.toThrow()
  })
})

describe('SupabaseStore.listPendingOwnerChanges', () => {
  it('lists the main groups that name the person as the unconfirmed nominee after the Owner left', async () => {
    const { store, calls } = stubDb([{ data: [{ id: 'g1' }, { id: 'g2' }], error: null }])
    expect(await store.listPendingOwnerChanges('Unew')).toEqual(['g1', 'g2'])
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['nominated_owner_line_user_id', 'Unew'] },
      { method: 'eq', args: ['is_main', true] },
      { method: 'not', args: ['owner_left_at', 'is', null] },
      { method: 'is', args: ['owner_confirmed_at', null] },
      { method: 'is', args: ['left_at', null] },
    ]))
  })
})
