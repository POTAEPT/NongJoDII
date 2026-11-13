import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore, WEEKLY_PAGE } from '@/server/store/supabase-store'

// SupabaseStore.listWeeklySummaryGroups against a stand-in for the PostgREST query
// builder: every filter call returns the builder, and .range() answers one page.

type Call = { method: string; args: unknown[] }

function stubDb(pages: Record<string, unknown>[][]) {
  const calls: Call[] = []
  let page = 0
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_target, prop) => {
      const method = String(prop)
      if (method === 'then') return undefined // the builder itself is never awaited
      return (...args: unknown[]) => {
        calls.push({ method, args })
        if (method === 'range') return Promise.resolve({ data: pages[page++] ?? [], error: null })
        return builder
      }
    },
  })
  const db = { from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder } }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
}

const rows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `g-${String(offset + i).padStart(5, '0')}`, line_group_id: `C${offset + i}`,
    weekly_summary_weekday: 3, weekly_summary_time: '09:00:00', weekly_summary_last_sent_on: null,
  }))

describe('SupabaseStore.listWeeklySummaryGroups', () => {
  it('reads every page, not only the first PostgREST page', async () => {
    const { store, calls } = stubDb([rows(WEEKLY_PAGE), rows(WEEKLY_PAGE, WEEKLY_PAGE), rows(5, 2 * WEEKLY_PAGE)])
    const groups = await store.listWeeklySummaryGroups(3)
    expect(groups).toHaveLength(2 * WEEKLY_PAGE + 5)
    expect(groups[2 * WEEKLY_PAGE + 4]).toEqual({
      groupId: 'g-02004', lineGroupId: 'C2004', weekday: 3, time: '09:00:00', lastSentOn: null,
    })
    expect(calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
      [0, WEEKLY_PAGE - 1], [WEEKLY_PAGE, 2 * WEEKLY_PAGE - 1], [2 * WEEKLY_PAGE, 3 * WEEKLY_PAGE - 1],
    ])
  })

  it('stops after one short page, and filters by weekday in the query', async () => {
    const { store, calls } = stubDb([rows(2)])
    expect(await store.listWeeklySummaryGroups(3)).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'range')).toHaveLength(1)
    expect(calls).toContainEqual({ method: 'eq', args: ['weekly_summary_weekday', 3] })
    expect(calls).toContainEqual({ method: 'order', args: ['id'] })
  })

  it('asks for one more page when the last full page ends exactly on the page size', async () => {
    const { store, calls } = stubDb([rows(WEEKLY_PAGE), []])
    expect(await store.listWeeklySummaryGroups(3)).toHaveLength(WEEKLY_PAGE)
    expect(calls.filter((c) => c.method === 'range')).toHaveLength(2)
  })
})

const taskRows = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t-${String(offset + i).padStart(5, '0')}`, title: `Task ${offset + i}`, status: 'not_assigned',
    assignee_line_user_id: null, due_at: null, last_activity_at: '2026-11-15T05:00:00Z', deleted_at: null,
  }))

describe('SupabaseStore.listReminderTasks (#44)', () => {
  it('reads every page, so Tasks after the first 1000 still reach the selection', async () => {
    const { store, calls } = stubDb([taskRows(WEEKLY_PAGE), taskRows(3, WEEKLY_PAGE)])
    const tasks = await store.listReminderTasks('g-1')
    expect(tasks).toHaveLength(WEEKLY_PAGE + 3)
    expect(tasks.at(-1)).toMatchObject({ id: 't-01002', title: 'Task 1002', assigneeLineUserId: null })
    expect(calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([
      [0, WEEKLY_PAGE - 1], [WEEKLY_PAGE, 2 * WEEKLY_PAGE - 1],
    ])
  })

  it('keeps the oldest-first order the selection relies on, and filters live open Tasks in the query', async () => {
    const { store, calls } = stubDb([taskRows(2)])
    await store.listReminderTasks('g-1')
    expect(calls).toContainEqual({ method: 'order', args: ['created_at', { ascending: true }] })
    expect(calls).toContainEqual({ method: 'neq', args: ['status', 'done'] })
    expect(calls).toContainEqual({ method: 'is', args: ['deleted_at', null] })
  })
})
