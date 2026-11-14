import { describe, expect, it } from 'vitest'
import {
  calendarWeek, canCompare, countByStatus, dueLabel, filterTasks, initialScope, memberCards, nextDueTask,
  progressPercent, summarizeGroups, tasksDueOn, unownedTasks,
  type DashboardData, type DashboardGroup, type DashboardTask,
} from '@/app/liff/dashboard-model'
import { readLiffParams } from '@/app/liff/params'

// #18 Dashboard screen: what a PM and a Member see, from the Dashboard read (#17).
// Wed 11 Nov 2026 10:00 Bangkok.
const NOW = new Date('2026-11-11T10:00:00+07:00')
const task = (id: string, status: DashboardTask['status'], assignee: string | null, dueAt: string | null): DashboardTask => ({
  taskId: id, title: `งาน ${id}`, status, assigneeLineUserId: assignee, assigneeName: null, dueAt,
})
const dii: DashboardGroup = {
  groupId: 'g1', name: 'กลุ่มโปรเจกต์ DII',
  members: [
    { lineUserId: 'u1', displayName: 'เจฟ' }, { lineUserId: 'u2', displayName: 'เต๋' },
    { lineUserId: 'u3', displayName: 'นน' }, { lineUserId: 'u4', displayName: 'บิว' },
  ],
  tasks: [
    task('t1', 'in_process', 'u1', '2026-11-12T17:00:00+07:00'),
    task('t2', 'in_process', 'u2', '2026-11-12T13:00:00+07:00'),
    task('t3', 'in_process', 'u3', '2026-11-12T12:00:00+07:00'),
    task('t4', 'done', 'u4', '2026-11-10T12:00:00+07:00'),
    task('t5', 'not_assigned', null, '2026-11-13T17:00:00+07:00'),
  ],
}
const design: DashboardGroup = { groupId: 'g2', name: null, members: [], tasks: [task('t6', 'done', null, null)] }

describe('Dashboard model (#18)', () => {
  it('counts the three status labels and the progress percent', () => {
    const counts = countByStatus(dii.tasks)
    expect(counts).toEqual({ not_assigned: 1, in_process: 3, done: 1 })
    expect(progressPercent(counts)).toBe(20)
    expect(progressPercent(countByStatus([]))).toBe(0)
  })

  it('compares groups side by side, with a fallback for a group without a name', () => {
    const [a, b] = summarizeGroups([dii, design])
    expect(a).toMatchObject({ name: 'กลุ่มโปรเจกต์ DII', memberCount: 4, taskCount: 5, percent: 20 })
    expect(a.nextDue?.taskId).toBe('t3')
    expect(b).toMatchObject({ name: 'กลุ่ม LINE', percent: 100, nextDue: null })
  })

  it('shows each member by LINE name with their current Task, and idle when they have none', () => {
    const cards = memberCards(dii)
    expect(cards.map((c) => [c.name, c.state, c.task?.taskId])).toEqual([
      ['เจฟ', 'working', 't1'], ['เต๋', 'working', 't2'], ['นน', 'working', 't3'], ['บิว', 'done', 't4'],
    ])
    expect(memberCards({ ...dii, tasks: [] }).every((c) => c.state === 'idle')).toBe(true)
    expect(memberCards({ ...dii, members: [{ lineUserId: 'u9', displayName: null }] })[0].name).toBe('สมาชิก LINE')
  })

  it('lists Tasks nobody has taken, soonest first', () => {
    expect(unownedTasks(dii.tasks).map((t) => t.taskId)).toEqual(['t5'])
  })

  it('filters Tasks by status and puts Done last', () => {
    expect(filterTasks(dii.tasks, 'in_process').map((t) => t.taskId)).toEqual(['t3', 't2', 't1'])
    expect(filterTasks(dii.tasks, 'all').map((t) => t.taskId)).toEqual(['t3', 't2', 't1', 't5', 't4'])
  })

  it('next due ignores Done Tasks and Tasks without a date', () => {
    expect(nextDueTask(dii.tasks)?.taskId).toBe('t3')
    expect(nextDueTask([task('x', 'done', null, '2026-11-01T10:00:00+07:00'), task('y', 'in_process', 'u1', null)])).toBeNull()
  })

  it('writes due dates in Bangkok time', () => {
    expect(dueLabel('2026-11-11T17:00:00+07:00', NOW)).toBe('วันนี้ 17:00')
    expect(dueLabel('2026-11-12T17:00:00+07:00', NOW)).toBe('พรุ่งนี้ 17:00')
    expect(dueLabel('2026-11-13T17:00:00+07:00', NOW)).toBe('ศ. 13 พ.ย. 17:00')
    // 18:00 UTC on the 11th is already 01:00 on the 12th in Bangkok
    expect(dueLabel('2026-11-11T18:00:00Z', NOW)).toBe('พรุ่งนี้ 01:00')
    expect(dueLabel(null, NOW)).toBe('')
  })

  it('builds the Monday-to-Sunday week with the status dots', () => {
    const week = calendarWeek(dii.tasks, NOW)
    expect(week.range).toBe('9–15 พ.ย.')
    expect(week.days.map((d) => d.day)).toEqual([9, 10, 11, 12, 13, 14, 15])
    expect(week.days.find((d) => d.isToday)?.day).toBe(11)
    expect(week.days[3].statuses).toEqual(['in_process', 'in_process', 'in_process'])
    expect(week.dueCount).toBe(5)
    expect(calendarWeek(dii.tasks, NOW, 1).range).toBe('16–22 พ.ย.')
    expect(tasksDueOn(dii.tasks, '2026-11-12').map((t) => t.taskId)).toEqual(['t3', 't2', 't1'])
  })

  it('a PM compares groups; a Member does not, and one group has nothing to compare', () => {
    const pm: DashboardData = { role: 'pm', groups: [dii, design] }
    expect(canCompare(pm)).toBe(true)
    expect(canCompare({ role: 'member', groups: [dii, design] })).toBe(false)
    expect(canCompare({ role: 'pm', groups: [dii] })).toBe(false)
  })

  it('opens on the linked group when it is allowed, else the comparison or the first group', () => {
    const pm: DashboardData = { role: 'pm', groups: [dii, design] }
    const member: DashboardData = { role: 'member', groups: [dii, design] }
    expect(initialScope(pm, 'g2')).toBe('g2')
    expect(initialScope(pm, null)).toBe('all')
    expect(initialScope(member, null)).toBe('g1')
    expect(initialScope(member, 'g-not-mine')).toBe('g1') // a group the server did not send is never selected
  })

  it('opens from the weekly insight link (view=dashboard)', () => {
    expect(readLiffParams('?view=dashboard&id=g1')).toEqual({ view: 'dashboard', id: 'g1' })
    expect(readLiffParams('?liff.state=%3Fview%3Ddashboard')).toEqual({ view: 'dashboard', id: null })
  })
})
