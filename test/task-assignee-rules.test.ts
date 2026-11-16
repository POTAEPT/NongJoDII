import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSIGNEE_TEXT } from '@/server/tasks/assignee'
import { loadTask, type TaskView } from '@/server/tasks/load'
import { updateTaskFromLiff } from '@/server/tasks/update'
import { makeTestDeps, TEST_NOW } from './harness'

// #121: a Task someone has moves only by that person, the group's Owner or a PM, and the
// group is told (one push through the budget) when someone else moves it.

const OWNER = 'Uowner1'
const MEMBERS = [
  { lineUserId: 'Upim', displayName: 'Pim Sirin' },
  { lineUserId: 'Ubank', displayName: 'Bank T.' },
  { lineUserId: 'Umint', displayName: 'Mint' },
]

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

function setup(assignee: string | null) {
  const h = makeTestDeps()
  // A real Project row, so the PM check (listDashboardMemberships) can see it.
  const project = h.store.seedProject(OWNER)
  const group = h.store.seedGroup({ lineGroupId: 'Cteam', name: 'ทีม', projectId: project.id, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW })
  for (const m of [{ lineUserId: OWNER, displayName: 'Owner' }, ...MEMBERS]) h.store.seedMember({ groupId: group.id, ...m })
  for (const [tok, id, name] of [['tok-owner', OWNER, 'Owner'], ['tok-pim', 'Upim', 'Pim Sirin'], ['tok-bank', 'Ubank', 'Bank T.'], ['tok-mint', 'Umint', 'Mint']]) {
    h.line.idTokens.set(tok, { lineUserId: id, displayName: name })
  }
  h.line.groupMemberCounts.set(group.lineGroupId, 4)
  const task = h.store.seedTask({
    groupId: group.id, title: 'ทำสไลด์', createdByLineUserId: 'Upim',
    status: assignee ? 'in_process' : 'not_assigned', assigneeLineUserId: assignee,
  })
  const edit = (idToken: string, assigneeLineUserId: string | null, extra: Record<string, unknown> = {}) =>
    updateTaskFromLiff(h.deps, { idToken, taskId: task.id, title: 'ทำสไลด์', details: null, assigneeLineUserId, dueAt: null, ...extra })
  const stored = () => h.store.tables.tasks.find((t) => t.id === task.id)!
  const notices = () => h.line.pushes.map((p) => p.messages[0]).filter((m) => m.type === 'text').map((m) => (m as { text: string }).text)
  return { ...h, group, task, edit, stored, notices }
}

describe('who may move a Task someone has (#121)', () => {
  it('another Member cannot change or clear it: 403 not_allowed, nothing written, no notice', async () => {
    const s = setup('Upim')
    expect(await s.edit('tok-bank', 'Ubank')).toEqual({ status: 403, body: { error: 'not_allowed' } })
    expect(await s.edit('tok-bank', null)).toEqual({ status: 403, body: { error: 'not_allowed' } })
    expect(s.stored().assigneeLineUserId).toBe('Upim')
    expect(s.line.pushes).toEqual([])
  })

  it('the same Member may still edit the other fields', async () => {
    const s = setup('Upim')
    const res = await s.edit('tok-bank', 'Upim', { title: 'ทำสไลด์ใหม่' })
    expect(res.status).toBe(200)
    expect(s.stored()).toMatchObject({ title: 'ทำสไลด์ใหม่', assigneeLineUserId: 'Upim' })
    expect(s.line.pushes).toEqual([])
  })

  it('the assignee, the Owner and a PM may move it, and the group is told', async () => {
    const byAssignee = setup('Upim')
    expect((await byAssignee.edit('tok-pim', 'Ubank')).status).toBe(200)
    expect(byAssignee.notices()).toEqual([ASSIGNEE_TEXT.moved('Pim Sirin', 'ทำสไลด์', 'Pim Sirin', 'Bank T.')])

    const byOwner = setup('Upim')
    expect((await byOwner.edit('tok-owner', 'Umint')).status).toBe(200)
    expect(byOwner.notices()).toEqual([ASSIGNEE_TEXT.moved('Owner', 'ทำสไลด์', 'Pim Sirin', 'Mint')])
    expect(byOwner.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'task_reassigned', lineTargetId: byOwner.group.lineGroupId })])

    const byPm = setup('Upim')
    byPm.store.tables.group_members.find((m) => m.groupId === byPm.group.id && m.lineUserId === 'Umint')!.isPm = true
    expect((await byPm.edit('tok-mint', null)).status).toBe(200)
    expect(byPm.notices()).toEqual([ASSIGNEE_TEXT.moved('Mint', 'ทำสไลด์', 'Pim Sirin', ASSIGNEE_TEXT.nobody)])
  })

  it('an unowned Task: any live Member may assign it; taking it yourself sends no notice', async () => {
    const other = setup(null)
    expect((await other.edit('tok-bank', 'Upim')).status).toBe(200)
    expect(other.notices()).toEqual([ASSIGNEE_TEXT.moved('Bank T.', 'ทำสไลด์', ASSIGNEE_TEXT.nobody, 'Pim Sirin')])
    const self = setup(null)
    expect((await self.edit('tok-bank', 'Ubank')).status).toBe(200)
    expect(self.stored().assigneeLineUserId).toBe('Ubank')
    expect(self.line.pushes).toEqual([])
  })

  it('near the monthly quota the notice is skipped, and the move still saves', async () => {
    const s = setup('Upim')
    s.line.quota = { limit: 300, used: 299 }
    expect((await s.edit('tok-owner', 'Ubank')).status).toBe(200)
    expect(s.stored().assigneeLineUserId).toBe('Ubank')
    expect(s.line.pushes).toEqual([])
  })

  it('the Task page says whether the requester may move the assignee', async () => {
    const s = setup('Upim')
    const view = async (idToken: string) => ((await loadTask(s.deps, { idToken, taskId: s.task.id })).body as TaskView).canChangeAssignee
    expect(await view('tok-bank')).toBe(false)
    expect(await view('tok-pim')).toBe(true)
    expect(await view('tok-owner')).toBe(true)
    const open = setup(null)
    expect(((await loadTask(open.deps, { idToken: 'tok-bank', taskId: open.task.id })).body as TaskView).canChangeAssignee).toBe(true)
  })
})
