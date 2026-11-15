import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore's #32 daily member check methods against a stand-in that records each
// PostgREST query (table, operation, payload, filters) and answers from a queue. The
// predicates carry the rules: one claim per day and group, a claim that expires, and the
// finish or release touching only the claim this attempt holds.

type Query = { table: string; op: string; payload?: unknown; filters: string[]; order: string[] }

function recordingDb(answers: unknown[] = []) {
  const queries: Query[] = []
  const from = (table: string) => {
    const q: Query = { table, op: 'select', filters: [], order: [] }
    queries.push(q)
    const b = {
      select(cols: string) { if (q.op === 'select') q.payload = cols; return b },
      update(v: unknown) { q.op = 'update'; q.payload = v; return b },
      eq(c: string, v: unknown) { q.filters.push(`${c}=eq.${String(v)}`); return b },
      is(c: string, v: unknown) { q.filters.push(`${c}=is.${String(v)}`); return b },
      or(f: string) { q.filters.push(`or=${f}`); return b },
      order(c: string) { q.order.push(c); return b },
      range() { return b },
      then(resolve: (a: { data: unknown; error: null }) => void) {
        resolve({ data: answers.length > 0 ? answers.shift() : null, error: null })
      },
    }
    return b
  }
  return { store: new SupabaseStore({ from } as unknown as SupabaseClient), queries }
}

const AT = new Date('2026-11-12T01:00:00.000Z')
const STALE = new Date('2026-11-12T00:50:00.000Z')
const TODAY = '2026-11-12'

describe('SupabaseStore #32 member check', () => {
  it('claimMemberCheck takes the group only when the day is unchecked and no live claim holds it', async () => {
    const won = recordingDb([[{ id: 'g1' }]])
    expect(await won.store.claimMemberCheck('g1', TODAY, AT, STALE)).toEqual({ claimed: true })
    expect(won.queries[0]).toMatchObject({
      table: 'groups', op: 'update',
      payload: { member_check_claimed_at: AT.toISOString() },
      filters: [
        'id=eq.g1',
        `or=and(or(member_check_on.is.null,member_check_on.lt.${TODAY}),` +
          `or(member_check_claimed_at.is.null,member_check_claimed_at.lt."${STALE.toISOString()}"))`,
      ],
    })
    expect(await recordingDb([[]]).store.claimMemberCheck('g1', TODAY, AT, STALE)).toEqual({ claimed: false })
  })

  it('finishMemberCheck marks the day and clears only the claim this attempt holds', async () => {
    const { store, queries } = recordingDb()
    await store.finishMemberCheck('g1', TODAY, AT)
    expect(queries[0]).toMatchObject({
      table: 'groups', op: 'update',
      payload: { member_check_on: TODAY, member_check_claimed_at: null },
      filters: ['id=eq.g1', `member_check_claimed_at=eq.${AT.toISOString()}`],
    })
  })

  it('releaseMemberCheck clears only the claim this attempt holds and leaves the day unchecked', async () => {
    const { store, queries } = recordingDb()
    await store.releaseMemberCheck('g1', AT)
    expect(queries[0]).toMatchObject({
      table: 'groups', op: 'update',
      payload: { member_check_claimed_at: null },
      filters: ['id=eq.g1', `member_check_claimed_at=eq.${AT.toISOString()}`],
    })
  })

  it('listMembersToCheck lists live Members not asked today, in user ID order', async () => {
    const { store, queries } = recordingDb([[{ line_user_id: 'Ua' }, { line_user_id: 'Ub' }]])
    expect(await store.listMembersToCheck('g1', TODAY)).toEqual(['Ua', 'Ub'])
    expect(queries[0]).toMatchObject({
      table: 'group_members', op: 'select',
      filters: ['group_id=eq.g1', 'left_at=is.null', `or=member_checked_on.is.null,member_checked_on.lt.${TODAY}`],
      order: ['line_user_id'],
    })
  })

  it('markMemberChecked stamps one Member of one group for the day', async () => {
    const { store, queries } = recordingDb()
    await store.markMemberChecked('g1', 'Ua', TODAY)
    expect(queries[0]).toMatchObject({
      table: 'group_members', op: 'update',
      payload: { member_checked_on: TODAY },
      filters: ['group_id=eq.g1', 'line_user_id=eq.Ua'],
    })
  })
})
