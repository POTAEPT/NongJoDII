import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { loadTask } from '@/server/tasks/load'
import { updateTaskFromLiff } from '@/server/tasks/update'
import type { TaskView } from '@/server/tasks/load'
import { makeTestDeps, seedOwnedGroup, TEST_NOW } from './harness'

const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: ['พิม'] },
  { lineUserId: 'Ubank', displayName: 'Bank T.', nicknames: ['แบงค์'] },
]

function setup(task: { status?: 'not_assigned' | 'in_process' | 'done'; assignee?: string | null; deleted?: boolean } = {}) {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  h.line.idTokens.set('tok-bank', { lineUserId: 'Ubank', displayName: 'Bank T.' })
  h.line.idTokens.set('tok-out', { lineUserId: 'Uoutsider', displayName: 'Outsider' })
  const row = h.store.seedTask({
    groupId: group.id, title: 'ทำสไลด์', createdByLineUserId: 'Upim',
    status: task.status ?? 'in_process', assigneeLineUserId: task.assignee === undefined ? 'Upim' : task.assignee,
    deletedAt: task.deleted ? new Date(TEST_NOW.getTime()) : null,
  })
  const stored = () => h.store.tables.tasks.find((t) => t.id === row.id)!
  const edit = (p: Record<string, unknown> = {}) =>
    updateTaskFromLiff(h.deps, {
      idToken: 'tok-bank', taskId: row.id, title: 'ชื่อใหม่', details: 'รายละเอียดใหม่',
      assigneeLineUserId: null, dueAt: '2026-11-20T17:00:00+07:00', ...p,
    })
  return { ...h, group, row, stored, edit }
}

describe('updateTaskFromLiff', () => {
  it('edits fields, records the verified editor and keeps the creator', async () => {
    const s = setup()
    const res = await s.edit()
    expect(res.status).toBe(200)
    const t = s.stored()
    expect(t).toMatchObject({
      title: 'ชื่อใหม่', details: 'รายละเอียดใหม่', assigneeLineUserId: null, status: 'not_assigned',
      lastEditedByLineUserId: 'Ubank', createdByLineUserId: 'Upim',
    })
    expect(t.lastActivityAt).toEqual(s.deps.now())
    expect(t.dueAt).toEqual(new Date('2026-11-20T17:00:00+07:00'))
    const view = res.body as TaskView
    expect(view).toMatchObject({ taskId: s.row.id, title: 'ชื่อใหม่', status: 'not_assigned', assigneeLineUserId: null })
    expect(view.dueAt).toBe('2026-11-20T10:00:00.000Z')
  })

  it('assigning a not_assigned task makes it in_process', async () => {
    const s = setup({ status: 'not_assigned', assignee: null })
    expect((await s.edit({ assigneeLineUserId: 'Upim' })).status).toBe(200)
    expect(s.stored()).toMatchObject({ assigneeLineUserId: 'Upim', status: 'in_process' })
  })

  it('a done task stays done when reassigned', async () => {
    const s = setup({ status: 'done' })
    expect((await s.edit({ assigneeLineUserId: 'Ubank' })).status).toBe(200)
    expect(s.stored()).toMatchObject({ assigneeLineUserId: 'Ubank', status: 'done' })
  })

  it('rejects an outsider with 403, a deleted task with 404, an empty title with 400', async () => {
    const s = setup()
    expect((await s.edit({ idToken: 'tok-out' })).status).toBe(403)
    expect(s.stored().title).toBe('ทำสไลด์')
    const bad = await s.edit({ title: '   ' })
    expect(bad).toEqual({ status: 400, body: { error: 'bad_request', field: 'title' } })
    expect(s.stored()).toMatchObject({ title: 'ทำสไลด์', lastEditedByLineUserId: null })
    expect((await s.edit({ taskId: 'nope' })).body).toEqual({ error: 'bad_request', field: 'taskId' })
    expect((await s.edit({ taskId: randomUUID() })).status).toBe(404)
    const d = setup({ deleted: true })
    expect((await d.edit()).status).toBe(404)
    expect((await loadTask(d.deps, { idToken: 'tok-bank', taskId: d.row.id })).status).toBe(404)
  })

  it('answers 404 and changes nothing when the task is deleted after the gate', async () => {
    const s = setup()
    const real = s.store.getTask.bind(s.store)
    vi.spyOn(s.store, 'getTask').mockImplementationOnce(async (id) => {
      const t = await real(id)
      s.stored().deletedAt = new Date(TEST_NOW.getTime())
      return t
    })
    expect(await s.edit()).toEqual({ status: 404, body: { error: 'not_found' } })
    expect(s.stored().title).toBe('ทำสไลด์')
  })

  it('FakeStore.updateTask skips a soft-deleted task', async () => {
    const d = setup({ deleted: true })
    const patch = { title: 'x', details: null, assigneeLineUserId: null, status: 'not_assigned' as const, dueAt: null, lastEditedByLineUserId: 'Ubank', lastActivityAt: TEST_NOW }
    expect(await d.store.updateTask(d.row.id, patch)).toEqual({ updated: false })
    expect(d.stored().title).toBe('ทำสไลด์')
  })

  it('identity comes only from the verified token', async () => {
    const s = setup()
    for (const idToken of ['bad', undefined, '']) {
      expect((await s.edit({ idToken, lineUserId: 'Ubank' })).status).toBe(401)
      expect((await loadTask(s.deps, { idToken, taskId: s.row.id, lineUserId: 'Ubank' })).status).toBe(401)
    }
    expect(s.stored().title).toBe('ทำสไลด์')
    expect((await s.edit({ lineUserId: 'Uowner1', userId: 'Uowner1' })).status).toBe(200)
    expect(s.stored().lastEditedByLineUserId).toBe('Ubank')
  })
})

describe('loadTask', () => {
  it('returns the task with members carrying LINE names only', async () => {
    const s = setup()
    const res = await loadTask(s.deps, { idToken: 'tok-bank', taskId: s.row.id })
    expect(res.status).toBe(200)
    const view = res.body as TaskView
    expect(view).toMatchObject({ taskId: s.row.id, title: 'ทำสไลด์', status: 'in_process', assigneeLineUserId: 'Upim' })
    expect(view.members).toContainEqual({ lineUserId: 'Upim', displayName: 'Pim Sirin' })
    for (const m of view.members) expect(Object.keys(m).sort()).toEqual(['displayName', 'lineUserId'])
    expect(JSON.stringify(view)).not.toContain('พิม')
  })
})
