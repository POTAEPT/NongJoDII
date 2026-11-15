import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore.getGroupSetup against a stand-in for the PostgREST query builder: every
// filter call returns the builder, and .maybeSingle() answers the row.

type Call = { method: string; args: unknown[] }

function stubDb(row: Record<string, unknown> | null) {
  const calls: Call[] = []
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_target, prop) => {
      const method = String(prop)
      if (method === 'then') return undefined // the builder itself is never awaited
      return (...args: unknown[]) => {
        calls.push({ method, args })
        if (method === 'maybeSingle') return Promise.resolve({ data: row, error: null })
        return builder
      }
    },
  })
  const db = { from: (table: string) => { calls.push({ method: 'from', args: [table] }); return builder } }
  return { store: new SupabaseStore(db as unknown as SupabaseClient), calls }
}

const ROW = {
  id: 'g1', line_group_id: 'C1', name: 'ทีม', project_id: null, work_description: null,
  feature_summarize: true, feature_draft_tasks: true, feature_save_files: false,
  feature_track_remind: true, feature_weekly_summary: true,
  daily_reminder_time: '08:45:00', weekly_summary_weekday: 5, weekly_summary_time: '17:30:00',
  nominated_owner_line_user_id: 'Upim', owner_confirmed_at: null, owner_nominated_at: '2026-11-12T03:00:00+00:00',
}

describe('SupabaseStore.getGroupSetup', () => {
  it('reads the nomination time with the setup columns and maps the row', async () => {
    const { store, calls } = stubDb(ROW)
    const setup = await store.getGroupSetup('g1')
    expect(setup).toEqual({
      groupId: 'g1', lineGroupId: 'C1', name: 'ทีม', projectId: null, workDescription: null,
      features: { summarize: true, draftTasks: true, saveFiles: false, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '08:45', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
      nominatedOwnerLineUserId: 'Upim', ownerConfirmedAt: null, ownerNominatedAt: new Date('2026-11-12T03:00:00Z'),
    })
    const columns = String(calls.find((c) => c.method === 'select')?.args[0]).split(',').map((c) => c.trim())
    expect(columns).toContain('owner_nominated_at')
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'g1'] })
  })

  it('answers null for an unknown group', async () => {
    expect(await stubDb(null).store.getGroupSetup('g-missing')).toBeNull()
  })
})
