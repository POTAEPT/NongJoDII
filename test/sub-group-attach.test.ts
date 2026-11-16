import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialSetupForm, setAttach, toSubmitBody } from '@/app/liff/setup-model'
import { SupabaseStore } from '@/server/store/supabase-store'
import { loadSetup } from '@/server/setup/load'
import { submitSetup } from '@/server/setup/submit'
import type { SetupLoad, SetupSubmitResult } from '@/server/setup/types'
import { makeTestDeps, TEST_NOW } from './harness'

// #146: the setup form attaches a new group to a Project the sender already owns, as a Sub
// group (rpc setup_sub_group), instead of always making a new Project. The picker lists only
// the sender's own Projects; the Sub group's Owner is the Project's owner, confirmed at once.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const OWNER = 'Uowner1'

function setup() {
  const h = makeTestDeps()
  const project = h.store.seedProject(OWNER)
  const main = h.store.seedGroup({ lineGroupId: 'Cmain', name: 'ทีมหลัก', projectId: project.id, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
  h.store.tables.group_setups.push({ groupId: main.id, isMain: true, featureSaveFiles: true, ownerNominatedByLineUserId: OWNER, ownerNominatedAt: TEST_NOW })
  h.store.seedMember({ groupId: main.id, lineUserId: OWNER, displayName: 'Owner' })
  // The new group: the bot just joined, nobody set it up yet.
  const fresh = h.store.seedGroup({ lineGroupId: 'Cnew', name: 'ทีม Dev' })
  for (const [id, name] of [[OWNER, 'Owner'], ['Upim', 'Pim']]) h.store.seedMember({ groupId: fresh.id, lineUserId: id, displayName: name })
  h.line.idTokens.set('tok-owner', { lineUserId: OWNER, displayName: 'Owner' })
  h.line.idTokens.set('tok-pim', { lineUserId: 'Upim', displayName: 'Pim' })
  h.line.groupMemberCounts.set('Cnew', 2)
  const body = (p: Record<string, unknown> = {}) => ({
    idToken: 'tok-owner', groupId: fresh.id, workDescription: 'ทีม Dev ของแอป',
    features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
    members: [{ lineUserId: 'Upim', nicknames: ['พิม'], role: 'Dev' }], ownerLineUserId: OWNER,
    attachProjectId: project.id, tagSet: ['โค้ด'], ...p,
  })
  const row = () => h.store.tables.groups.find((g) => g.id === fresh.id)!
  const isMain = () => h.store.tables.group_setups.find((r) => r.groupId === fresh.id)?.isMain === true
  return { ...h, project, main, fresh, body, row, isMain }
}

describe('the attach picker (#146)', () => {
  it('lists the requester\'s own Projects by main group name', async () => {
    const s = setup()
    const view = (await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.fresh.id })).body as SetupLoad
    expect(view.attachOptions).toEqual([{ projectId: s.project.id, name: 'ทีมหลัก' }])
  })

  it('is empty for someone who owns no Project', async () => {
    const s = setup()
    const view = (await loadSetup(s.deps, { idToken: 'tok-pim', groupId: s.fresh.id })).body as SetupLoad
    expect(view.attachOptions).toEqual([])
  })

  it('choosing a Project makes the requester the Owner and sends attachProjectId', async () => {
    const s = setup()
    const view = (await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.fresh.id })).body as SetupLoad
    const form = setAttach({ ...initialSetupForm(view), ownerLineUserId: 'Upim' }, s.project.id, OWNER)
    expect(form.ownerLineUserId).toBe(OWNER)
    expect(toSubmitBody(form)).toMatchObject({ attachProjectId: s.project.id, ownerLineUserId: OWNER })
    expect(toSubmitBody(setAttach(form, null, OWNER))).not.toHaveProperty('attachProjectId')
  })
})

describe('submit with attachProjectId (#146)', () => {
  it('saves the form and attaches the group as a confirmed Sub group, with no new Project', async () => {
    const s = setup()
    const res = await submitSetup(s.deps, s.body(), s.defer)
    expect(res.status).toBe(200)
    expect(res.body as SetupSubmitResult).toMatchObject({ state: 'confirmed', attached: true })
    expect(s.row()).toMatchObject({ projectId: s.project.id, nominatedOwnerLineUserId: OWNER, workDescription: 'ทีม Dev ของแอป' })
    expect(s.row().ownerConfirmedAt).toEqual(s.deps.now())
    expect(s.isMain()).toBe(false)
    expect(s.store.tables.projects).toHaveLength(1)
    const pim = s.store.tables.group_members.find((m) => m.groupId === s.fresh.id && m.lineUserId === 'Upim')!
    expect(pim).toMatchObject({ nicknames: ['พิม'], role: 'Dev' })
    // The setup-done card goes to the new group.
    expect(s.line.pushes.map((p) => p.to)).toContain('Cnew')
  })

  it('refuses a Project the sender does not own, and changes nothing', async () => {
    const s = setup()
    const other = s.store.seedProject('Uother')
    expect(await submitSetup(s.deps, s.body({ attachProjectId: other.id }), s.defer)).toEqual({ status: 403, body: { error: 'not_project_owner' } })
    expect(s.row()).toMatchObject({ projectId: null, ownerConfirmedAt: null })
  })

  it('refuses a Project whose main group the bot has left', async () => {
    const s = setup()
    await s.store.markBotLeft({ lineGroupId: 'Cmain', at: TEST_NOW })
    expect((await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.fresh.id })).body).toMatchObject({ attachOptions: [] })
    expect((await submitSetup(s.deps, s.body(), s.defer)).status).toBe(403)
  })

  it('a Sub group cannot name another Owner', async () => {
    const s = setup()
    expect(await submitSetup(s.deps, s.body({ ownerLineUserId: 'Upim' }), s.defer))
      .toEqual({ status: 400, body: { error: 'bad_request', field: 'ownerLineUserId' } })
    expect(s.row().projectId).toBeNull()
  })

  it('a bad attachProjectId is a 400; a group already set up is closed', async () => {
    const s = setup()
    expect((await submitSetup(s.deps, s.body({ attachProjectId: 'nope' }), s.defer)).body).toEqual({ error: 'bad_request', field: 'attachProjectId' })
    expect((await submitSetup(s.deps, s.body(), s.defer)).status).toBe(200)
    expect((await submitSetup(s.deps, s.body(), s.defer)).status).toBe(409)
  })

  it('without attachProjectId the form still makes a new Project', async () => {
    const s = setup()
    expect((await submitSetup(s.deps, s.body({ attachProjectId: null }), s.defer)).status).toBe(200)
    expect(s.store.tables.projects).toHaveLength(2)
    expect(s.isMain()).toBe(true)
  })
})

describe('SupabaseStore.saveSubGroupSetup (#146)', () => {
  function rpcDb(answers: { data: unknown; error: { code: string; message: string } | null }[]) {
    const calls: { fn?: string; args?: unknown; table?: string; patch?: unknown }[] = []
    const db = {
      rpc: (fn: string, args: unknown) => { calls.push({ fn, args }); return Promise.resolve(answers.shift()!) },
      from: (table: string) => ({
        update: (patch: unknown) => ({ eq: () => { calls.push({ table, patch }); return Promise.resolve({ error: null }) } }),
      }),
    }
    return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
  }
  const w = {
    groupId: 'g1', projectId: 'p1', byLineUserId: OWNER, workDescription: null,
    features: { summarize: true, draftTasks: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', members: [], at: TEST_NOW, tagSet: ['โค้ด'],
  }

  it('calls setup_sub_group, then writes the tag set when attached', async () => {
    const { store, calls } = rpcDb([{ data: 'attached', error: null }])
    expect(await store.saveSubGroupSetup(w)).toEqual({ outcome: 'attached' })
    expect(calls[0]).toMatchObject({ fn: 'setup_sub_group', args: { p_group_id: 'g1', p_project_id: 'p1', p_by: OWNER } })
    expect(calls[1]).toEqual({ table: 'groups', patch: { tag_set: ['โค้ด'] } })
  })

  it('passes the other outcomes through, without the tag write, and throws on an unknown one', async () => {
    for (const outcome of ['closed', 'not_member', 'not_project_owner']) {
      const { store, calls } = rpcDb([{ data: outcome, error: null }])
      expect(await store.saveSubGroupSetup(w)).toEqual({ outcome })
      expect(calls).toHaveLength(1)
    }
    await expect(rpcDb([{ data: 'weird', error: null }]).store.saveSubGroupSetup(w)).rejects.toThrow()
  })
})
