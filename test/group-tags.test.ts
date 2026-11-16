import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { stepForField } from '@/app/liff/setup-model'
import { SupabaseStore } from '@/server/store/supabase-store'
import { buildSummaryPrompt } from '@/server/summary/prompt'

// #110: the group's starting tags (groups.tag_set): the migration, the Summary prompt that
// picks from them first, and the store's write after setup_group.

describe('migration 20261116170000_group_tag_set.sql', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '20261116170000_group_tag_set.sql'), 'utf8').toLowerCase()
  it('adds groups.tag_set, empty by default, capped at 20', () => {
    expect(sql).toContain("add column tag_set text[] not null default '{}'")
    expect(sql).toContain('check (cardinality(tag_set) <= 20)')
  })
})

describe('the Summary prompt', () => {
  it('lists the group\'s tags first and tells the model to pick from them', () => {
    const p = buildSummaryPrompt({
      now: new Date(), workDescription: null, members: [], messages: [], groupTags: ['ออกแบบ', 'เอกสาร'],
      existingTasks: [{ title: 'ทำสไลด์', status: 'done', tags: ['สไลด์'] }],
    })
    expect(p.user).toContain('Group tags (set by the Owner; use these first): ออกแบบ, เอกสาร')
    expect(p.user).toContain('Tags in use: สไลด์')
    expect(p.system).toContain('Pick from "Group tags" first')
  })

  it('has no group tags line when the group has none', () => {
    expect(buildSummaryPrompt({ now: new Date(), workDescription: null, members: [], messages: [] }).user).not.toContain('Group tags')
  })
})

describe('the setup form page', () => {
  it('a refused tag set sends the person back to step 1', () => {
    expect(stepForField('tagSet')?.step).toBe(1)
  })
})

describe('SupabaseStore.saveGroupSetup writes the tag set after setup_group', () => {
  type Call = { method: string; args: unknown[] }
  function stub(results: { data: unknown; error: { code: string } | null }[]) {
    const chains: Call[][] = []
    const next = () => Promise.resolve(results.shift() ?? { data: null, error: null })
    const db = {
      rpc: (name: string, args: unknown) => { chains.push([{ method: 'rpc', args: [name, args] }]); return { then: (a: never, b: never) => next().then(a, b) } },
      from: (table: string) => {
        const calls: Call[] = [{ method: 'from', args: [table] }]
        chains.push(calls)
        const builder: Record<string, unknown> = new Proxy({}, {
          get: (_t, prop) => (prop === 'then'
            ? (a: never, b: never) => next().then(a, b)
            : (...args: unknown[]) => { calls.push({ method: String(prop), args }); return builder }),
        })
        return builder
      },
    }
    return { store: new SupabaseStore(db as unknown as SupabaseClient), chains }
  }
  const write = {
    groupId: 'g1', byLineUserId: 'U1', workDescription: null,
    features: { summarize: true, draftTasks: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', members: [],
    ownerLineUserId: 'U1', at: new Date('2026-11-16T00:00:00Z'), tagSet: ['ออกแบบ'],
  }

  it('on a saved form (pending or confirmed)', async () => {
    const { store, chains } = stub([{ data: 'pending', error: null }, { data: null, error: null }])
    expect(await store.saveGroupSetup(write)).toEqual({ outcome: 'pending' })
    expect(chains[1]).toEqual([
      { method: 'from', args: ['groups'] },
      { method: 'update', args: [{ tag_set: ['ออกแบบ'] }] },
      { method: 'eq', args: ['id', 'g1'] },
    ])
  })

  it('not on a closed form, nor with no tags; a failed write is logged and the form stays saved', async () => {
    const closed = stub([{ data: 'closed', error: null }])
    await closed.store.saveGroupSetup(write)
    expect(closed.chains).toHaveLength(1)
    const none = stub([{ data: 'confirmed', error: null }])
    await none.store.saveGroupSetup({ ...write, tagSet: [] })
    expect(none.chains).toHaveLength(1)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = stub([{ data: 'confirmed', error: null }, { data: null, error: { code: '23514' } }])
    expect(await failed.store.saveGroupSetup(write)).toEqual({ outcome: 'confirmed' })
    expect(errors.mock.calls.map((c) => String(c[0])).join()).toContain('group_tag_set_failed')
    errors.mockRestore()
  })
})
