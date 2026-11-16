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
    expect(calls).toContainEqual({ method: 'filter', args: ['nominated_owner_line_user_id', 'eq', 'Uold'] })
    expect(calls).toContainEqual({ method: 'filter', args: ['is_main', 'eq', true] })
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
      { data: { nominated_owner_line_user_id: 'Uother' }, error: null }, // read again after the lost CAS
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'taken' })
  })

  it('two presses of the same person at once: the press that lost the CAS answers already_claimed', async () => {
    const { store, calls } = stubDb([
      { data: PENDING, error: null },
      { data: { left_at: '2026-11-12T03:00:00+00:00' }, error: null },
      { data: [], error: null }, // the other press won
      { data: { nominated_owner_line_user_id: 'Unew' }, error: null },
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'already_claimed' })
    expect(calls).toContainEqual({ method: 'select', args: ['nominated_owner_line_user_id'] })
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
      { method: 'or', args: ['is_main.eq.true,project_id.is.null'] },
      { method: 'not', args: ['owner_left_at', 'is', null] },
      { method: 'is', args: ['owner_confirmed_at', null] },
      { method: 'is', args: ['left_at', null] },
    ]))
  })
})

describe('SupabaseStore #30 reconcile queries (#74)', () => {
  it('listConfirmedOwnersWhoLeft reads confirmed live groups, then only their nominees\' left rows', async () => {
    const { store, calls } = stubDb([
      {
        data: [
          { id: 'g1', line_group_id: 'C1', nominated_owner_line_user_id: 'Uowner', owner_confirmed_at: '2026-11-01T03:00:00+00:00' },
          { id: 'g2', line_group_id: 'C2', nominated_owner_line_user_id: 'Unew', owner_confirmed_at: '2026-11-05T03:00:00+00:00' },
        ],
        error: null,
      },
      {
        data: [
          { group_id: 'g1', line_user_id: 'Uowner', left_at: '2026-11-12T03:00:00+00:00' },
          // Another group's nominee who also left g1 is not g1's Owner.
          { group_id: 'g1', line_user_id: 'Unew', left_at: '2026-11-12T03:00:00+00:00' },
          // Confirmed after leaving (a take-over of a Sub group they had left): not a lost leave.
          { group_id: 'g2', line_user_id: 'Unew', left_at: '2026-11-02T03:00:00+00:00' },
        ],
        error: null,
      },
    ])
    expect(await store.listConfirmedOwnersWhoLeft()).toEqual([
      { groupId: 'g1', lineGroupId: 'C1', lineUserId: 'Uowner', leftAt: new Date('2026-11-12T03:00:00Z') },
    ])
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'from', args: ['groups'] },
      { method: 'not', args: ['owner_confirmed_at', 'is', null] },
      { method: 'is', args: ['left_at', null] },
      { method: 'from', args: ['group_members'] },
      { method: 'in', args: ['group_id', ['g1', 'g2']] },
      { method: 'in', args: ['line_user_id', ['Uowner', 'Unew']] },
      { method: 'not', args: ['left_at', 'is', null] },
    ]))
  })
})

describe('SupabaseStore.listOwnerlessGroups (#30 part B)', () => {
  it('lists groups the bot is in with no confirmed Owner since owner_left_at <= the cutoff, oldest first', async () => {
    const { store, calls } = stubDb([{
      data: [{
        id: 'g1', line_group_id: 'C1', project_id: 'p1', is_main: false, nominated_owner_line_user_id: 'Uold',
        owner_left_at: '2026-11-06T03:00:00+00:00', joined_at: '2026-11-01T03:00:00+00:00',
      }],
      error: null,
    }])
    expect(await store.listOwnerlessGroups(AT, 50)).toEqual([{
      groupId: 'g1', lineGroupId: 'C1', subGroup: true, nominatedOwnerLineUserId: 'Uold',
      ownerLeftAt: new Date('2026-11-06T03:00:00Z'), joinedAt: new Date('2026-11-01T03:00:00Z'),
    }])
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'lte', args: ['owner_left_at', AT.toISOString()] },
      { method: 'is', args: ['owner_confirmed_at', null] },
      { method: 'is', args: ['left_at', null] },
      { method: 'order', args: ['owner_left_at', { ascending: true }] },
      { method: 'limit', args: [50] },
    ]))
  })
})

describe('SupabaseStore.claimOwnerChange on a group with no Project (#30 part B)', () => {
  it('claims a detached Sub group whose Owner left, guarded on project_id is null', async () => {
    const { store, calls } = stubDb([
      { data: { ...PENDING, is_main: false, project_id: null }, error: null },
      { data: { left_at: '2026-11-12T03:00:00+00:00' }, error: null },
      { data: [{ id: 'g1' }], error: null },
    ])
    expect(await store.claimOwnerChange('g1', 'Unew', AT)).toEqual({ outcome: 'claimed' })
    expect(calls).toContainEqual({ method: 'filter', args: ['project_id', 'is', null] })
  })
})

describe('SupabaseStore.detachOwnerlessSubGroup (#30 part B)', () => {
  it('detaches in one conditional UPDATE and resets owner_left_at', async () => {
    const before = new Date('2026-11-06T03:00:00Z')
    const { store, calls } = stubDb([{ data: [{ id: 'g1' }], error: null }])
    expect(await store.detachOwnerlessSubGroup('g1', before, AT)).toEqual({ detached: true })
    expect(calls).toContainEqual({
      method: 'update',
      args: [{
        project_id: null, takeover_asked_at: null, drive_folder_id: null, owner_left_at: AT.toISOString(),
        nominated_owner_line_user_id: null, owner_nominated_by_line_user_id: null, owner_nominated_at: null,
      }],
    })
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'not', args: ['project_id', 'is', null] },
      { method: 'eq', args: ['is_main', false] },
      { method: 'is', args: ['owner_confirmed_at', null] },
      { method: 'lte', args: ['owner_left_at', before.toISOString()] },
      { method: 'is', args: ['left_at', null] },
    ]))
  })

  it('answers detached false when the group no longer matches (already detached)', async () => {
    expect(await stubDb([{ data: [], error: null }]).store.detachOwnerlessSubGroup('g1', AT, AT)).toEqual({ detached: false })
  })
})

describe('SupabaseStore.getOwnerExitState (#30 part B)', () => {
  it('maps the re-read columns', async () => {
    const { store } = stubDb([{
      data: {
        project_id: 'p1', is_main: true, owner_confirmed_at: null, owner_left_at: '2026-11-06T03:00:00+00:00',
        left_at: null, joined_at: '2026-11-01T03:00:00+00:00', owner_nominated_at: null,
      },
      error: null,
    }])
    expect(await store.getOwnerExitState('g1')).toEqual({
      ownerConfirmedAt: null, ownerLeftAt: new Date('2026-11-06T03:00:00Z'), leftAt: null,
      joinedAt: new Date('2026-11-01T03:00:00Z'), subGroup: false, ownerNominatedAt: null,
    })
  })
})

describe('SupabaseStore.answerOwnerNeededPrompt (#30 part B)', () => {
  it('answers only the open owner_needed card', async () => {
    const { store, calls } = stubDb([{ data: null, error: null }])
    await store.answerOwnerNeededPrompt('g1', 'Unew', AT)
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'update', args: [{ answer: 'owner_confirmed', answered_by_line_user_id: 'Unew', answered_at: AT.toISOString() }] },
      { method: 'eq', args: ['kind', 'owner_needed'] },
      { method: 'is', args: ['answer', null] },
    ]))
  })
})

describe('SupabaseStore.startDetachedOwnerCount (#30 part B)', () => {
  const row = (p: Record<string, unknown> = {}) => ({
    id: 'g1', project_id: null, owner_confirmed_at: null, owner_left_at: null, owner_nominated_at: null, ...p,
  })

  it('reads the groups, then writes the count with a compare-and-set on a group with no Project and no Owner', async () => {
    const { store, calls } = stubDb([{ data: [row()], error: null }, { data: [{ id: 'g1' }], error: null }])
    expect(await store.startDetachedOwnerCount(['g1'], AT)).toEqual(['g1'])
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'in', args: ['id', ['g1']] },
      {
        method: 'update',
        args: [{ owner_left_at: AT.toISOString(), nominated_owner_line_user_id: null, owner_nominated_by_line_user_id: null, owner_nominated_at: null }],
      },
      { method: 'eq', args: ['id', 'g1'] },
      { method: 'is', args: ['project_id', null] },
      { method: 'is', args: ['owner_confirmed_at', null] },
      { method: 'filter', args: ['owner_left_at', 'is', null] },
      { method: 'filter', args: ['owner_nominated_at', 'is', null] },
    ]))
  })

  it('skips a group still in a Project, a count newer than `at`, and a claim made since the count started', async () => {
    for (const r of [
      row({ project_id: 'p1' }),
      row({ owner_left_at: '2026-11-14T03:00:00+00:00' }),
      row({ owner_left_at: '2026-11-10T03:00:00+00:00', owner_nominated_at: '2026-11-11T03:00:00+00:00' }),
    ]) {
      const { store, calls } = stubDb([{ data: [r], error: null }])
      expect(await store.startDetachedOwnerCount(['g1'], AT)).toEqual([])
      expect(calls.some((c) => c.method === 'update')).toBe(false)
    }
  })

  it('clears a nominee from before the Owner left (an old count)', async () => {
    const { store } = stubDb([
      { data: [row({ owner_left_at: '2026-11-01T03:00:00+00:00', owner_nominated_at: '2026-10-01T03:00:00+00:00' })], error: null },
      { data: [{ id: 'g1' }], error: null },
    ])
    expect(await store.startDetachedOwnerCount(['g1'], AT)).toEqual(['g1'])
  })

  it('does nothing for no groups', async () => {
    const { store, calls } = stubDb([])
    expect(await store.startDetachedOwnerCount([], AT)).toEqual([])
    expect(calls).toEqual([])
  })
})
