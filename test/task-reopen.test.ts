import { beforeEach, describe, expect, it, vi } from 'vitest'
import { alreadyUpdatedCard, PROGRESS_TEXT } from '@/server/progress/card'
import { loadTask, type TaskView } from '@/server/tasks/load'
import { reopenTaskFromLiff } from '@/server/tasks/reopen'
import { makeTestDeps, TEST_NOW } from './harness'

// #139: "ยังไม่เสร็จ" on the Task page. A Done Task goes back to In Process (with its
// assignee) or Not Assigned (without), done_at cleared, by the assignee, the Owner or a PM.
// The #87 card ("อัปเดตไปแล้ว ยังไม่ได้ยกเลิก") sends people here to undo a wrong pick.

const OWNER = 'Uowner1'
const DONE_AT = new Date(TEST_NOW.getTime() - 3600_000)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function setup(p: { assignee: string | null; status?: 'done' | 'in_process' }) {
  const h = makeTestDeps()
  // A real Project row, so the PM check (listDashboardMemberships) can see it.
  const project = h.store.seedProject(OWNER)
  const group = h.store.seedGroup({ lineGroupId: 'Cteam', name: 'ทีม', projectId: project.id, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
  for (const m of [{ lineUserId: OWNER, displayName: 'Owner' }, { lineUserId: 'Upim', displayName: 'Pim' }, { lineUserId: 'Ubank', displayName: 'Bank' }]) {
    h.store.seedMember({ groupId: group.id, ...m })
  }
  for (const [tok, id, name] of [['tok-owner', OWNER, 'Owner'], ['tok-pim', 'Upim', 'Pim'], ['tok-bank', 'Ubank', 'Bank'], ['tok-out', 'Uout', 'Out']]) {
    h.line.idTokens.set(tok, { lineUserId: id, displayName: name })
  }
  const task = h.store.seedTask({
    groupId: group.id, title: 'จองห้อง', createdByLineUserId: 'Upim',
    status: p.status ?? 'done', assigneeLineUserId: p.assignee,
  })
  const stored = () => h.store.tables.tasks.find((t) => t.id === task.id)!
  if ((p.status ?? 'done') === 'done') stored().doneAt = DONE_AT
  const reopen = (idToken: string) => reopenTaskFromLiff(h.deps, { idToken, taskId: task.id })
  return { ...h, task, stored, reopen }
}

describe('reopen a Done Task (#139)', () => {
  it('the assignee reopens it: In Process, same assignee, done_at cleared, editor recorded, no message', async () => {
    const s = setup({ assignee: 'Upim' })
    const res = await s.reopen('tok-pim')
    expect(res.status).toBe(200)
    expect(s.stored()).toMatchObject({
      status: 'in_process', assigneeLineUserId: 'Upim', doneAt: null, lastEditedByLineUserId: 'Upim',
    })
    expect(s.stored().lastActivityAt).toEqual(s.deps.now())
    expect(res.body as TaskView).toMatchObject({ status: 'in_process', canReopen: false })
    expect(s.line.pushes).toEqual([])
    expect(s.line.replies).toEqual([])
  })

  it('a Done Task with no assignee goes back to Not Assigned, and any Member may reopen it', async () => {
    const s = setup({ assignee: null })
    expect((await s.reopen('tok-bank')).status).toBe(200)
    expect(s.stored()).toMatchObject({ status: 'not_assigned', assigneeLineUserId: null, doneAt: null })
  })

  it('the Owner may reopen a Task someone else has', async () => {
    const s = setup({ assignee: 'Upim' })
    expect((await s.reopen('tok-owner')).status).toBe(200)
    expect(s.stored()).toMatchObject({ status: 'in_process', lastEditedByLineUserId: OWNER })
  })

  it('another Member cannot reopen a Task someone has: 403 not_allowed, nothing written', async () => {
    const s = setup({ assignee: 'Upim' })
    expect(await s.reopen('tok-bank')).toEqual({ status: 403, body: { error: 'not_allowed' } })
    expect(s.stored()).toMatchObject({ status: 'done', doneAt: DONE_AT })
  })

  it('an outsider gets 403 and a bad token 401', async () => {
    const s = setup({ assignee: 'Upim' })
    expect((await s.reopen('tok-out')).status).toBe(403)
    expect((await s.reopen('nope')).status).toBe(401)
    expect(s.stored().status).toBe('done')
  })

  it('a Task that is not Done answers 409 not_done and changes nothing', async () => {
    const s = setup({ assignee: 'Upim', status: 'in_process' })
    expect(await s.reopen('tok-pim')).toEqual({ status: 409, body: { error: 'not_done' } })
    expect(s.stored().lastEditedByLineUserId).toBeNull()
  })

  it('a Task reassigned after the read is not reopened: 409 changed with the Task as it is now', async () => {
    const s = setup({ assignee: 'Upim' })
    const real = s.store.getTask.bind(s.store)
    vi.spyOn(s.store, 'getTask').mockImplementationOnce(async (id) => {
      const t = await real(id)
      s.stored().assigneeLineUserId = 'Ubank' // moved by someone else in between
      return t
    })
    const res = await s.reopen('tok-pim')
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'changed', task: { status: 'done', assigneeLineUserId: 'Ubank' } })
    expect(s.stored()).toMatchObject({ status: 'done', doneAt: DONE_AT })
  })

  it('a second reopen is a conflict, not a second write', async () => {
    const s = setup({ assignee: 'Upim' })
    expect((await s.reopen('tok-pim')).status).toBe(200)
    expect((await s.reopen('tok-pim')).body).toEqual({ error: 'not_done' })
  })
})

describe('the Task page knows who may reopen (#139)', () => {
  it('canReopen: true for the assignee and the Owner on a Done Task, false for others and open Tasks', async () => {
    const s = setup({ assignee: 'Upim' })
    const view = async (idToken: string) => ((await loadTask(s.deps, { idToken, taskId: s.task.id })).body as TaskView).canReopen
    expect(await view('tok-pim')).toBe(true)
    expect(await view('tok-owner')).toBe(true)
    expect(await view('tok-bank')).toBe(false)
    const open = setup({ assignee: 'Upim', status: 'in_process' })
    expect(((await loadTask(open.deps, { idToken: 'tok-pim', taskId: open.task.id })).body as TaskView).canReopen).toBe(false)
  })

  it('the #87 card now tells people how to undo it', async () => {
    const s = setup({ assignee: 'Upim' })
    const task = (await s.store.getTask(s.task.id))!
    const card = alreadyUpdatedCard({ liffId: s.deps.config.liffId, updates: [{ task, status: 'done' }] })
    expect(JSON.stringify(card)).toContain('ยังไม่เสร็จ')
    expect(PROGRESS_TEXT.alreadyUpdatedHint).toContain('ยังไม่เสร็จ')
  })
})
