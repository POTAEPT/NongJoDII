import { describe, expect, it } from 'vitest'
import { statusFor, validateTaskFields } from '@/server/tasks/fields'
import { makeTestDeps, seedOwnedGroup } from './harness'

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: [{ lineUserId: 'Upim', displayName: 'Pim Sirin' }] })
  h.store.seedMember({ groupId: group.id, lineUserId: 'Uleft', displayName: 'Gone', leftAt: new Date('2026-11-01T00:00:00Z') })
  const base = { title: 'ทำสไลด์', details: null, assigneeLineUserId: null, dueAt: null }
  return { ...h, group, base }
}

describe('validateTaskFields', () => {
  it.each([
    ['empty title', { title: '   ' }, 'title'],
    ['201-char title', { title: 'ก'.repeat(201) }, 'title'],
    ['non-string title', { title: 7 }, 'title'],
    ['2001-char details', { details: 'x'.repeat(2001) }, 'details'],
    ['unparseable dueAt', { dueAt: 'nope' }, 'dueAt'],
    ['non-member assignee', { assigneeLineUserId: 'Ustranger' }, 'assigneeLineUserId'],
    ['left-member assignee', { assigneeLineUserId: 'Uleft' }, 'assigneeLineUserId'],
  ] as const)('%s fails on its field', async (_name, patch, field) => {
    const t = setup()
    const r = await validateTaskFields(t.store, t.group.id, { ...t.base, ...patch })
    expect(r).toEqual({ ok: false, field })
  })

  it('returns the first failing field', async () => {
    const t = setup()
    const r = await validateTaskFields(t.store, t.group.id, { title: '', details: 5, assigneeLineUserId: 'Ux', dueAt: 'nope' })
    expect(r).toEqual({ ok: false, field: 'title' })
  })

  it('blank details become null', async () => {
    const t = setup()
    const r = await validateTaskFields(t.store, t.group.id, { ...t.base, details: '  ' })
    expect(r).toEqual({ ok: true, fields: { title: 'ทำสไลด์', details: null, assigneeLineUserId: null, dueAt: null } })
  })

  it('valid input gives trimmed fields and a Date', async () => {
    const t = setup()
    const r = await validateTaskFields(t.store, t.group.id, {
      title: '  ทำสไลด์ 10 หน้า ', details: ' ส่งก่อนประชุม ', assigneeLineUserId: 'Upim', dueAt: '2026-11-21T09:00:00+07:00',
    })
    expect(r).toEqual({
      ok: true,
      fields: {
        title: 'ทำสไลด์ 10 หน้า', details: 'ส่งก่อนประชุม', assigneeLineUserId: 'Upim',
        dueAt: new Date('2026-11-21T02:00:00Z'),
      },
    })
  })

  it('accepts a 200-char title and 2000-char details', async () => {
    const t = setup()
    const r = await validateTaskFields(t.store, t.group.id, { ...t.base, title: 'ก'.repeat(200), details: 'x'.repeat(2000) })
    expect(r.ok).toBe(true)
  })
})

describe('statusFor', () => {
  it('follows D13', () => {
    expect(statusFor('U1', null)).toBe('in_process')
    expect(statusFor(null, null)).toBe('not_assigned')
    expect(statusFor(null, 'in_process')).toBe('not_assigned')
    expect(statusFor('U1', 'not_assigned')).toBe('in_process')
    expect(statusFor(null, 'done')).toBe('done')
    expect(statusFor('U1', 'done')).toBe('done')
  })
})
