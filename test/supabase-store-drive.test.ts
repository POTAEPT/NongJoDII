import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@/server/log'
import { PAGE_SIZE, SupabaseStore } from '@/server/store/supabase-store'

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

/** The .range() arguments of each chain that has one, in order. */
const ranges = (chains: Call[][]) =>
  chains.flatMap((c) => c.filter((x) => x.method === 'range').map((x) => x.args))

describe('SupabaseStore.listConfirmedOwnerProjects', () => {
  it('reads confirmed, live main groups of the person, a page at a time in id order', async () => {
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
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
  })

  it('reads the next page after a full one, so Projects past the first 1000 rows are not missed', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => ({ project_id: `p${i}` }))
    const { store, chains } = stubDb([ok(full), ok([{ project_id: 'p-last' }])])
    const ids = await store.listConfirmedOwnerProjects('U1')
    expect(ids).toHaveLength(PAGE_SIZE + 1)
    expect(ids.at(-1)).toBe('p-last')
    expect(ranges(chains)).toEqual([[0, PAGE_SIZE - 1], [PAGE_SIZE, 2 * PAGE_SIZE - 1]])
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
    expect(chains[1]).toContainEqual({ method: 'order', args: ['id'] })
    expect(chains[2]).toContainEqual({ method: 'eq', args: ['line_user_id', 'U1'] })
    expect(chains[3]).toContainEqual({ method: 'eq', args: ['status', 'active'] })
  })

  it('reads the next page of groups after a full one, so groups past the first 1000 rows still get folders', async () => {
    const groups = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({
      id: `g${offset + i}`, line_group_id: `C${offset + i}`, name: null, is_main: offset + i === 0, drive_folder_id: null,
    }))
    // Results go out in await order: the account and connection reads (run alongside the
    // groups) are awaited before the second page of groups.
    const { store, chains } = stubDb([
      ok({ id: 'p1', owner_line_user_id: 'U1', drive_project_folder_id: null }),
      ok(groups(PAGE_SIZE)),
      ok(null),
      ok(null),
      ok(groups(2, PAGE_SIZE)),
    ])
    const ctx = await store.getDriveContext('p1')
    expect(ctx?.mainGroup?.groupId).toBe('g0')
    expect(ctx?.subGroups).toHaveLength(PAGE_SIZE + 1)
    expect(ctx?.subGroups.at(-1)?.groupId).toBe(`g${PAGE_SIZE + 1}`)
    const groupChains = chains.filter((c) => c[0].args[0] === 'groups')
    expect(ranges(groupChains)).toEqual([[0, PAGE_SIZE - 1], [PAGE_SIZE, 2 * PAGE_SIZE - 1]])
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

describe('SupabaseStore.listUnfinishedDriveProjects (#13 tick finisher)', () => {
  const FROM = new Date('2026-11-14T10:00:00Z')
  const TO = new Date('2026-11-14T11:58:00Z')
  const at = (hhmm: string) => `2026-11-14T${hhmm}:00+00:00`

  it('finds the Owners with a recent confirm or Google account write, then keeps their unconnected Projects whose later event is in the window', async () => {
    const { store, chains } = stubDb([
      // Owners: main groups confirmed since FROM, and Google accounts written since FROM.
      ok([{ nominated_owner_line_user_id: 'U1' }]),
      ok([{ line_user_id: 'U2' }, { line_user_id: 'U1' }, { line_user_id: 'U4' }]),
      // Their accounts, then their main groups.
      ok([
        { line_user_id: 'U1', token_status: 'valid', updated_at: at('09:00') },
        { line_user_id: 'U2', token_status: 'revoked', updated_at: at('08:00') },
        { line_user_id: 'U2', token_status: 'valid', updated_at: at('11:00') },
        { line_user_id: 'U4', token_status: 'valid', updated_at: at('05:00') },
        { line_user_id: 'U4', token_status: 'revoked', updated_at: at('11:30') },
      ]),
      ok([
        { project_id: 'p1', nominated_owner_line_user_id: 'U1', owner_confirmed_at: at('11:00') }, // confirm in the window
        { project_id: 'p2', nominated_owner_line_user_id: 'U2', owner_confirmed_at: at('06:00') }, // sign-in in the window
        { project_id: 'p3', nominated_owner_line_user_id: 'U2', owner_confirmed_at: at('11:59') }, // sign-in in the window, but confirmed under 2 minutes ago
        { project_id: 'p4', nominated_owner_line_user_id: 'U2', owner_confirmed_at: at('07:00') }, // already connected
        { project_id: 'p6', nominated_owner_line_user_id: 'U4', owner_confirmed_at: at('10:30') }, // latest account revoked
      ]),
      // Active connections of the Projects left.
      ok([{ project_id: 'p4' }]),
    ])
    expect(await store.listUnfinishedDriveProjects(FROM, TO)).toEqual(['p1', 'p2'])

    expect(chains[0]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['nominated_owner_line_user_id'] },
      { method: 'eq', args: ['is_main', true] },
      { method: 'not', args: ['project_id', 'is', null] },
      { method: 'is', args: ['left_at', null] },
      { method: 'gte', args: ['owner_confirmed_at', FROM.toISOString()] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
    expect(chains[1]).toEqual([
      { method: 'from', args: ['google_accounts'] },
      { method: 'select', args: ['line_user_id'] },
      { method: 'gte', args: ['updated_at', FROM.toISOString()] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
    expect(chains[2]).toEqual([
      { method: 'from', args: ['google_accounts'] },
      { method: 'select', args: ['line_user_id, token_status, updated_at'] },
      { method: 'in', args: ['line_user_id', ['U1', 'U2', 'U4']] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
    expect(chains[3]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'select', args: ['project_id, nominated_owner_line_user_id, owner_confirmed_at'] },
      { method: 'eq', args: ['is_main', true] },
      { method: 'in', args: ['nominated_owner_line_user_id', ['U1', 'U2', 'U4']] },
      { method: 'not', args: ['owner_confirmed_at', 'is', null] },
      { method: 'not', args: ['project_id', 'is', null] },
      { method: 'is', args: ['left_at', null] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
    expect(chains[4]).toEqual([
      { method: 'from', args: ['drive_connections'] },
      { method: 'select', args: ['project_id'] },
      { method: 'eq', args: ['status', 'active'] },
      { method: 'in', args: ['project_id', ['p1', 'p2', 'p4']] },
      { method: 'order', args: ['id'] },
      { method: 'range', args: [0, PAGE_SIZE - 1] },
    ])
  })

  it('reads nothing more when nobody confirmed or signed in since FROM', async () => {
    const { store, chains } = stubDb([ok([]), ok([])])
    expect(await store.listUnfinishedDriveProjects(FROM, TO)).toEqual([])
    expect(chains).toHaveLength(2)
  })

  it('reads every page and sends the Owners in chunks, so a long list neither loses rows nor grows the URL', async () => {
    const owners = Array.from({ length: PAGE_SIZE }, (_, i) => ({ nominated_owner_line_user_id: `U${i % 150}` }))
    const { store, chains } = stubDb([
      ok(owners), ok([]), ok([]), // confirms page 1 (full), sign-ins, confirms page 2
      ok([]), ok([]), ok([]), ok([]), // accounts and main groups, for two chunks of Owners
    ])
    expect(await store.listUnfinishedDriveProjects(FROM, TO)).toEqual([])
    const confirms = chains.filter((c) => c.some((x) => x.method === 'gte' && x.args[0] === 'owner_confirmed_at'))
    expect(ranges(confirms)).toEqual([[0, PAGE_SIZE - 1], [PAGE_SIZE, 2 * PAGE_SIZE - 1]])
    const inLists = chains.flatMap((c) => c.filter((x) => x.method === 'in').map((x) => (x.args[1] as string[]).length))
    expect(inLists).toEqual([100, 100, 50, 50])
  })

  it('throws an AdapterError with the code only', async () => {
    const { store } = stubDb([{ data: null, error: { code: '42501' } }, ok([])])
    const err = await store.listUnfinishedDriveProjects(FROM, TO).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('supabase listUnfinishedDriveProjects: 42501')
  })
})
