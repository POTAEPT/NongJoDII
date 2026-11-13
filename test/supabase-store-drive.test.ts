import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@/server/log'
import { SupabaseStore } from '@/server/store/supabase-store'

// The #13 SupabaseStore methods against a stand-in for the PostgREST query builder. Each
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
  }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), chains }
}

const ok = (data: unknown): Result => ({ data, error: null })

describe('SupabaseStore.listConfirmedOwnerProjects', () => {
  it('reads confirmed, live main groups of the person', async () => {
    const { store, chains } = stubDb([ok([{ project_id: 'p1' }, { project_id: 'p2' }])])
    expect(await store.listConfirmedOwnerProjects('U1')).toEqual(['p1', 'p2'])
    expect(chains[0]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['project_id'] },
      { method: 'eq', args: ['is_main', true] },
      { method: 'eq', args: ['nominated_owner_line_user_id', 'U1'] },
      { method: 'not', args: ['owner_confirmed_at', 'is', null] },
      { method: 'not', args: ['project_id', 'is', null] },
      { method: 'is', args: ['left_at', null] },
    ])
  })

  it('throws an AdapterError with the code only', async () => {
    const { store } = stubDb([{ data: null, error: { code: '42501' } }])
    const err = await store.listConfirmedOwnerProjects('U1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('supabase listConfirmedOwnerProjects: 42501')
  })
})

describe('SupabaseStore.getDriveContext', () => {
  it('maps the project, its confirmed live groups, the Owner\'s account and the active connection', async () => {
    const { store, chains } = stubDb([
      ok({ id: 'p1', owner_line_user_id: 'U1', drive_project_folder_id: 'fp' }),
      ok([
        { id: 'g1', line_group_id: 'C1', name: 'หลัก', is_main: true, drive_folder_id: 'fm' },
        { id: 'g2', line_group_id: 'C2', name: null, is_main: false, drive_folder_id: null },
      ]),
      ok({ id: 'a1', token_status: 'valid', refresh_token_ciphertext: 'v1.x', drive_root_folder_id: 'fr' }),
      ok({ google_account_id: 'a1' }),
    ])
    expect(await store.getDriveContext('p1')).toEqual({
      projectId: 'p1', ownerLineUserId: 'U1', projectFolderId: 'fp',
      mainGroup: { groupId: 'g1', lineGroupId: 'C1', name: 'หลัก', folderId: 'fm' },
      subGroups: [{ groupId: 'g2', lineGroupId: 'C2', name: null, folderId: null }],
      account: { id: 'a1', tokenStatus: 'valid', refreshTokenCiphertext: 'v1.x', rootFolderId: 'fr' },
      activeAccountId: 'a1',
    })
    expect(chains[1]).toContainEqual({ method: 'not', args: ['owner_confirmed_at', 'is', null] })
    expect(chains[1]).toContainEqual({ method: 'is', args: ['left_at', null] })
    expect(chains[2]).toContainEqual({ method: 'eq', args: ['line_user_id', 'U1'] })
    expect(chains[3]).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  it('answers null for an unknown project', async () => {
    const { store, chains } = stubDb([ok(null)])
    expect(await store.getDriveContext('p-missing')).toBeNull()
    expect(chains).toHaveLength(1)
  })
})

describe('SupabaseStore folder setters (compare-and-set)', () => {
  it('writes only while the column is still empty, with IS NULL', async () => {
    const { store, chains } = stubDb([ok([{ id: 'a1' }])])
    expect(await store.setDriveRootFolder('a1', null, 'f1')).toEqual({ folderId: 'f1' })
    expect(chains[0]).toEqual([
      { method: 'from', args: ['google_accounts'] },
      { method: 'update', args: [{ drive_root_folder_id: 'f1' }] },
      { method: 'eq', args: ['id', 'a1'] },
      { method: 'is', args: ['drive_root_folder_id', null] },
      { method: 'select', args: ['id'] },
    ])
  })

  it('replaces only the expected old ID, and answers what another run stored when it matched nothing', async () => {
    const { store, chains } = stubDb([ok([]), ok({ drive_folder_id: 'f-other' })])
    expect(await store.setGroupDriveFolder('g1', 'f-old', 'f-new')).toEqual({ folderId: 'f-other' })
    expect(chains[0]).toContainEqual({ method: 'eq', args: ['drive_folder_id', 'f-old'] })
    expect(chains[0][0]).toEqual({ method: 'from', args: ['groups'] })
    expect(chains[1]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['drive_folder_id'] },
      { method: 'eq', args: ['id', 'g1'] },
      { method: 'maybeSingle', args: [] },
    ])
  })

  it('setProjectDriveFolder writes projects.drive_project_folder_id', async () => {
    const { store, chains } = stubDb([ok([{ id: 'p1' }])])
    expect(await store.setProjectDriveFolder('p1', null, 'f1')).toEqual({ folderId: 'f1' })
    expect(chains[0][0]).toEqual({ method: 'from', args: ['projects'] })
    expect(chains[0][1]).toEqual({ method: 'update', args: [{ drive_project_folder_id: 'f1' }] })
  })
})

describe('SupabaseStore.ensureDriveConnection', () => {
  it('inserts an active row when the Project has none', async () => {
    const { store, chains } = stubDb([ok([]), ok(null)])
    expect(await store.ensureDriveConnection('p1', 'a1')).toEqual({ created: true })
    expect(chains[1]).toEqual([
      { method: 'from', args: ['drive_connections'] },
      { method: 'insert', args: [{ project_id: 'p1', google_account_id: 'a1', status: 'active' }] },
    ])
  })

  it('leaves an existing active row alone', async () => {
    const { store, chains } = stubDb([ok([{ id: 'c1' }])])
    expect(await store.ensureDriveConnection('p1', 'a1')).toEqual({ created: false })
    expect(chains).toHaveLength(1)
  })

  it('reads a concurrent insert (23505 on drive_connections_one_active) as already there', async () => {
    const { store } = stubDb([ok([]), { data: null, error: { code: '23505' } }])
    expect(await store.ensureDriveConnection('p1', 'a1')).toEqual({ created: false })
  })

  it('throws on another insert error', async () => {
    const { store } = stubDb([ok([]), { data: null, error: { code: '23503' } }])
    expect(((await store.ensureDriveConnection('p1', 'a1').catch((e: unknown) => e)) as Error).message)
      .toBe('supabase ensureDriveConnection: 23503')
  })
})
