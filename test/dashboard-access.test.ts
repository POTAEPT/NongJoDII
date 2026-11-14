import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadDashboard, visibleGroups, type DashboardData } from '@/server/dashboard/load'
import { makeTestDeps, TEST_NOW } from './harness'

// #17 Dashboard read seam: the Dashboard data as seen by a PM, a Member, an outsider and a
// member who left. One Project (owner Upm) with a main group "DII" and two Sub groups.

function setup() {
  const h = makeTestDeps()
  const project = h.store.seedProject('Upm')
  const mk = (lineGroupId: string, name: string, isMain = false) => {
    const g = h.store.seedGroup({ lineGroupId, name, projectId: project.id })
    if (isMain) h.store.tables.group_setups.push({ groupId: g.id, isMain: true, featureSaveFiles: true, ownerNominatedByLineUserId: null, ownerNominatedAt: null })
    return g
  }
  const dii = mk('Cdii', 'กลุ่มโปรเจกต์ DII', true)
  const design = mk('Cdesign', 'ทีมออกแบบ')
  const client = mk('Cclient', 'งานลูกค้า')
  const member = (groupId: string, lineUserId: string, displayName: string, extra: { leftAt?: Date; isPm?: boolean; nicknames?: string[] } = {}) =>
    h.store.seedMember({ groupId, lineUserId, displayName, ...extra })
  member(dii.id, 'Upm', 'พีเอ็ม')
  member(dii.id, 'Ujeff', 'เจฟ', { nicknames: ['เจ'] })
  member(design.id, 'Unon', 'นน')
  member(design.id, 'Ujeff', 'เจฟ')
  member(client.id, 'Ubew', 'บิว')
  const task = (groupId: string, title: string, p: { status?: 'not_assigned' | 'in_process' | 'done'; assignee?: string | null; deleted?: boolean } = {}) =>
    h.store.seedTask({
      groupId, title, createdByLineUserId: 'Upm', status: p.status ?? 'in_process',
      assigneeLineUserId: p.assignee === undefined ? null : p.assignee,
      dueAt: new Date('2026-11-13T10:00:00Z'), deletedAt: p.deleted ? new Date(TEST_NOW.getTime()) : null,
    })
  task(dii.id, 'ทำสไลด์ Dashboard', { assignee: 'Ujeff' })
  task(design.id, 'ออกแบบโลโก้', { assignee: 'Unon' })
  task(client.id, 'ส่งงานลูกค้า', { assignee: 'Ubew' })
  task(client.id, 'งานที่ลบแล้ว', { assignee: 'Ubew', deleted: true })
  for (const [tok, id, name] of [['t-pm', 'Upm', 'พีเอ็ม'], ['t-jeff', 'Ujeff', 'เจฟ'], ['t-non', 'Unon', 'นน'], ['t-out', 'Uout', 'คนนอก']] as const) {
    h.line.idTokens.set(tok, { lineUserId: id, displayName: name })
  }
  const load = (idToken: string, extra: Record<string, unknown> = {}) => loadDashboard(h.deps, { idToken, ...extra })
  return { ...h, project, dii, design, client, member, task, load }
}

const names = (d: DashboardData) => d.groups.map((g) => g.name)

describe('loadDashboard (#17)', () => {
  it('a PM (the Project Owner) sees every group of the Project, main group first', async () => {
    const s = setup()
    const res = await s.load('t-pm')
    expect(res.status).toBe(200)
    const data = res.body as DashboardData
    expect(data.role).toBe('pm')
    expect(names(data)).toEqual(['กลุ่มโปรเจกต์ DII', 'ทีมออกแบบ', 'งานลูกค้า'])
    expect(data.groups[2].tasks.map((t) => t.title)).toEqual(['ส่งงานลูกค้า']) // the deleted Task is not shown
  })

  it('a member marked is_pm is a PM too', async () => {
    const s = setup()
    s.member(s.dii.id, 'Ujeff', 'เจฟ', { isPm: true })
    const data = (await s.load('t-jeff')).body as DashboardData
    expect(data.role).toBe('pm')
    expect(data.groups).toHaveLength(3)
  })

  it('a Member sees only their own groups and Tasks', async () => {
    const s = setup()
    const data = (await s.load('t-jeff')).body as DashboardData
    expect(data.role).toBe('member')
    expect(names(data)).toEqual(['กลุ่มโปรเจกต์ DII', 'ทีมออกแบบ'])
    const titles = data.groups.flatMap((g) => g.tasks.map((t) => t.title))
    expect(titles).toEqual(['ทำสไลด์ Dashboard', 'ออกแบบโลโก้'])
    expect(JSON.stringify(data)).not.toContain('ส่งงานลูกค้า')
  })

  it('shows LINE names, never nicknames', async () => {
    const s = setup()
    const data = (await s.load('t-pm')).body as DashboardData
    expect(data.groups[0].members.map((m) => m.displayName)).toEqual(['พีเอ็ม', 'เจฟ'])
    expect(data.groups[0].tasks[0].assigneeName).toBe('เจฟ')
    expect(JSON.stringify(data)).not.toContain('"เจ"')
  })

  it('an outsider is refused', async () => {
    const s = setup()
    const res = await s.load('t-out')
    expect(res).toEqual({ status: 403, body: { error: 'forbidden' } })
  })

  it('a member who left a group loses access to it, but keeps their other groups', async () => {
    const s = setup()
    s.member(s.design.id, 'Ujeff', 'เจฟ', { leftAt: new Date(TEST_NOW.getTime()) })
    const data = (await s.load('t-jeff')).body as DashboardData
    expect(names(data)).toEqual(['กลุ่มโปรเจกต์ DII'])
    expect(JSON.stringify(data)).not.toContain('ออกแบบโลโก้')
  })

  it('a member who left their only group is refused', async () => {
    const s = setup()
    s.member(s.design.id, 'Unon', 'นน', { leftAt: new Date(TEST_NOW.getTime()) })
    expect((await s.load('t-non')).status).toBe(403)
  })

  it('a PM does not see a group they left', async () => {
    const s = setup()
    s.member(s.client.id, 'Upm', 'พีเอ็ม', { leftAt: new Date(TEST_NOW.getTime()) })
    const data = (await s.load('t-pm')).body as DashboardData
    expect(names(data)).toEqual(['กลุ่มโปรเจกต์ DII', 'ทีมออกแบบ'])
  })

  it('a left Member leaves the member list but their Done Task keeps the name', async () => {
    const s = setup()
    s.member(s.design.id, 'Unon', 'นน', { leftAt: new Date(TEST_NOW.getTime()) })
    s.task(s.design.id, 'ส่งแบบ', { status: 'done', assignee: 'Unon' })
    const data = (await s.load('t-pm')).body as DashboardData
    const design = data.groups.find((g) => g.name === 'ทีมออกแบบ')!
    expect(design.members.map((m) => m.lineUserId)).toEqual(['Ujeff'])
    expect(design.tasks.find((t) => t.title === 'ส่งแบบ')).toMatchObject({ status: 'done', assigneeName: 'นน' })
  })

  it('a group the bot left is not shown', async () => {
    const s = setup()
    s.store.seedSchedule(s.client.id, { leftAt: new Date(TEST_NOW.getTime()) })
    const data = (await s.load('t-pm')).body as DashboardData
    expect(names(data)).toEqual(['กลุ่มโปรเจกต์ DII', 'ทีมออกแบบ'])
  })

  it('a group that is not in a Project is not shown', async () => {
    const s = setup()
    const loose = s.store.seedGroup({ lineGroupId: 'Cloose', name: 'กลุ่มที่ยังไม่ตั้งค่า' })
    s.member(loose.id, 'Unon', 'นน')
    expect(names((await s.load('t-non')).body as DashboardData)).toEqual(['ทีมออกแบบ'])
  })

  it('opening the LIFF from a group makes the person a Member when LINE says they are in it', async () => {
    const s = setup()
    s.line.idTokens.set('t-new', { lineUserId: 'Unew', displayName: 'ใหม่' })
    expect((await s.load('t-new')).status).toBe(403)
    s.line.profiles.set('Cdii:Unew', 'ใหม่')
    const res = await s.load('t-new', { groupId: s.dii.id })
    expect(res.status).toBe(200)
    expect(names(res.body as DashboardData)).toEqual(['กลุ่มโปรเจกต์ DII'])
    expect(await s.store.getMembership(s.dii.id, 'Unew')).toBe('live')
  })

  it('a link to a group does not reopen a group the person left', async () => {
    const s = setup()
    s.member(s.design.id, 'Unon', 'นน', { leftAt: new Date(TEST_NOW.getTime()) })
    s.line.profiles.set('Cdesign:Unon', 'นน')
    expect((await s.load('t-non', { groupId: s.design.id })).status).toBe(403)
  })

  it('rejects a missing or bad ID token (401) and a malformed groupId (400)', async () => {
    const s = setup()
    expect((await loadDashboard(s.deps, {})).status).toBe(401)
    expect((await s.load('t-unknown')).status).toBe(401)
    expect((await s.load('t-pm', { groupId: 'not-a-uuid' })).status).toBe(400)
    expect((await s.load('t-pm', { groupId: randomUUID() })).status).toBe(200) // unknown group: ignored
  })

  it('the requester comes only from the token, never from the body', async () => {
    const s = setup()
    const res = await s.load('t-out', { lineUserId: 'Upm', userId: 'Upm' })
    expect(res.status).toBe(403)
  })
})

describe('visibleGroups (the access rule)', () => {
  const g = (groupId: string, projectId: string) => ({ groupId, projectId, name: groupId })
  const m = (groupId: string, projectId: string, p: { left?: boolean; isPm?: boolean; owner?: string } = {}) => ({
    groupId, projectId, projectOwnerLineUserId: p.owner ?? 'Uother', isPm: p.isPm ?? false, left: p.left ?? false,
  })

  it('has no groups for someone with no live membership', () => {
    expect(visibleGroups('U1', [m('a', 'p', { left: true })], [g('a', 'p'), g('b', 'p')]).groups).toEqual([])
    expect(visibleGroups('U1', [], [g('a', 'p')])).toEqual({ groups: [], pm: false })
  })

  it('a PM of one Project does not widen another Project', () => {
    const out = visibleGroups('U1', [m('a', 'p', { isPm: true }), m('c', 'q')], [g('a', 'p'), g('b', 'p'), g('c', 'q'), g('d', 'q')])
    expect(out.groups.map((x) => x.groupId)).toEqual(['a', 'b', 'c'])
    expect(out.pm).toBe(true)
  })
})
