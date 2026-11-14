import type { TaskStatus } from '@/server/ports'
import { BKK_OFFSET_MS, bangkokParts, bangkokTodayLabel, bangkokWeekStartLabel, formatThaiWeekRange } from '@/server/time/bangkok'

// #18 Dashboard screen (Figma 6b), kept pure so it can be tested without a DOM.
// The data is the Dashboard read (#17, server/dashboard/load.ts): POST /api/dashboard/load answers with DashboardData,
// already limited to what the requester may see (a PM sees every group of the Project, a
// Member only their own groups; an outsider gets 403). This file never decides access.
// Names are LINE names, never nicknames (decided 2026-11-11).

export type { DashboardData, DashboardGroup, DashboardMember, DashboardTask } from '@/server/dashboard/load'
import type { DashboardData, DashboardGroup, DashboardMember, DashboardTask } from '@/server/dashboard/load'

// ---- Copy: the agreed UI status labels (docs/PROJECT.md) ----
export const STATUS_LABEL: Record<TaskStatus, string> = {
  not_assigned: 'ยังไม่มีผู้รับ', // also written รอรับ in the issue; the Figma frames use this one
  in_process: 'กำลังทำ',
  done: 'เสร็จ',
}
export const STATUS_ORDER: TaskStatus[] = ['not_assigned', 'in_process', 'done']
export const FALLBACK_MEMBER = 'สมาชิก LINE'
export const FALLBACK_GROUP = 'กลุ่ม LINE'

const THAI_WEEKDAY_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
const DAY_MS = 86_400_000
const pad = (n: number) => String(n).padStart(2, '0')

export function groupName(g: Pick<DashboardGroup, 'name'>): string {
  return g.name?.trim() ? g.name : FALLBACK_GROUP
}
export function memberName(m: Pick<DashboardMember, 'displayName'> | undefined): string {
  return m?.displayName?.trim() ? m.displayName : FALLBACK_MEMBER
}
/** First character of a LINE name, for the round avatar. */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

// ---- Counts and progress ----
export type StatusCounts = Record<TaskStatus, number>

export function countByStatus(tasks: Pick<DashboardTask, 'status'>[]): StatusCounts {
  const c: StatusCounts = { not_assigned: 0, in_process: 0, done: 0 }
  for (const t of tasks) c[t.status] += 1
  return c
}

/** Percent of Tasks that are Done, 0 when the group has none. */
export function progressPercent(counts: StatusCounts): number {
  const total = counts.not_assigned + counts.in_process + counts.done
  return total === 0 ? 0 : Math.round((counts.done / total) * 100)
}

export type GroupSummary = {
  groupId: string; name: string; memberCount: number; taskCount: number
  counts: StatusCounts; percent: number
  nextDue: DashboardTask | null // earliest due date among Tasks not Done
}

/** The PM's comparison across groups: one row per group, in the order the server gave. */
export function summarizeGroups(groups: DashboardGroup[]): GroupSummary[] {
  return groups.map((g) => {
    const counts = countByStatus(g.tasks)
    return {
      groupId: g.groupId, name: groupName(g), memberCount: g.members.length, taskCount: g.tasks.length,
      counts, percent: progressPercent(counts), nextDue: nextDueTask(g.tasks),
    }
  })
}

function dueMs(t: DashboardTask): number {
  return t.dueAt ? Date.parse(t.dueAt) : Number.NaN
}

export function nextDueTask(tasks: DashboardTask[]): DashboardTask | null {
  const open = tasks.filter((t) => t.status !== 'done' && !Number.isNaN(dueMs(t)))
  open.sort((a, b) => dueMs(a) - dueMs(b))
  return open[0] ?? null
}

// ---- Members (overview tab) ----
export type MemberCard = {
  lineUserId: string; name: string
  state: 'working' | 'done' | 'idle' // กำลังทำ / เสร็จ / ว่าง
  task: DashboardTask | null // the Task the card shows
  counts: StatusCounts
}

/** One card per member. A member with an In Process Task is working (earliest due first);
 *  otherwise one whose latest Task is Done shows it as done; otherwise idle. */
export function memberCards(g: DashboardGroup): MemberCard[] {
  return g.members.map((m) => {
    const mine = g.tasks.filter((t) => t.assigneeLineUserId === m.lineUserId)
    const working = mine.filter((t) => t.status === 'in_process').sort(byDue)
    const finished = mine.filter((t) => t.status === 'done')
    const state = working.length ? 'working' : finished.length ? 'done' : 'idle'
    const task = working[0] ?? finished[finished.length - 1] ?? null
    return { lineUserId: m.lineUserId, name: memberName(m), state, task, counts: countByStatus(mine) }
  })
}

export function overviewLine(cards: MemberCard[]): string {
  const working = cards.filter((c) => c.state === 'working').length
  const idle = cards.filter((c) => c.state === 'idle').length
  return `${working} คนกำลังทำงาน · ${idle} คนว่าง`
}

function byDue(a: DashboardTask, b: DashboardTask): number {
  const x = dueMs(a)
  const y = dueMs(b)
  if (Number.isNaN(x) && Number.isNaN(y)) return 0
  if (Number.isNaN(x)) return 1
  if (Number.isNaN(y)) return -1
  return x - y
}

/** Open Tasks nobody has taken, soonest due first: the banner under the member cards. */
export function unownedTasks(tasks: DashboardTask[]): DashboardTask[] {
  return tasks.filter((t) => t.status === 'not_assigned').sort(byDue)
}

export function tasksOf(g: DashboardGroup, lineUserId: string): { working: DashboardTask[]; done: DashboardTask[] } {
  const mine = g.tasks.filter((t) => t.assigneeLineUserId === lineUserId)
  return { working: mine.filter((t) => t.status === 'in_process').sort(byDue), done: mine.filter((t) => t.status === 'done') }
}

// ---- All Tasks tab ----
export type TaskFilter = 'all' | TaskStatus
export const FILTERS: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'ทั้งหมด' },
  { key: 'not_assigned', label: STATUS_LABEL.not_assigned },
  { key: 'in_process', label: STATUS_LABEL.in_process },
  { key: 'done', label: STATUS_LABEL.done },
]

/** Filtered Tasks: open ones first by due date, Done ones last. */
export function filterTasks(tasks: DashboardTask[], filter: TaskFilter): DashboardTask[] {
  const rank = (t: DashboardTask) => (t.status === 'done' ? 1 : 0)
  return tasks
    .filter((t) => filter === 'all' || t.status === filter)
    .sort((a, b) => rank(a) - rank(b) || byDue(a, b))
}

// ---- Due dates (Bangkok time, fixed UTC+7) ----
function dayNumber(d: Date): number {
  return Math.floor((d.getTime() + BKK_OFFSET_MS) / DAY_MS)
}
export function hhmm(d: Date): string {
  const p = bangkokParts(d)
  return `${pad(p.hh)}:${pad(p.mm)}`
}

/** 'วันนี้ 17:00', 'พรุ่งนี้ 17:00', 'ศ. 13 พ.ย. 17:00', or '' when there is no due date. */
export function dueLabel(iso: string | null, now: Date): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = dayNumber(d) - dayNumber(now)
  const time = hhmm(d)
  if (diff === 0) return `วันนี้ ${time}`
  if (diff === 1) return `พรุ่งนี้ ${time}`
  const p = bangkokParts(d)
  return `${weekdayShort(d)} ${p.d} ${THAI_MONTHS_SHORT[p.m - 1]} ${time}`
}

export function weekdayShort(d: Date): string {
  return THAI_WEEKDAY_SHORT[new Date(d.getTime() + BKK_OFFSET_MS).getUTCDay()]
}

export function isOverdue(t: DashboardTask, now: Date): boolean {
  return t.status !== 'done' && !Number.isNaN(dueMs(t)) && dueMs(t) < now.getTime()
}

// ---- Calendar tab ----
export type CalendarDay = { date: string; weekday: string; day: number; isToday: boolean; statuses: TaskStatus[] }
export type CalendarWeek = { weekStart: string; range: string; days: CalendarDay[]; dueCount: number }

function bangkokDateLabel(d: Date): string {
  return bangkokTodayLabel(d)
}

/** The Bangkok Monday-to-Sunday week `offset` weeks from the one holding `now`, with the
 *  status of each Task due that day (the dots under the date). */
export function calendarWeek(tasks: DashboardTask[], now: Date, offset = 0): CalendarWeek {
  const monday = new Date(`${bangkokWeekStartLabel(now)}T00:00:00+07:00`).getTime() + offset * 7 * DAY_MS
  const today = bangkokDateLabel(now)
  const days: CalendarDay[] = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(monday + i * DAY_MS)
    const date = bangkokDateLabel(start)
    const statuses = tasks.filter((t) => t.dueAt && bangkokDateLabel(new Date(t.dueAt)) === date).map((t) => t.status)
    return { date, weekday: weekdayShort(start), day: bangkokParts(start).d, isToday: date === today, statuses }
  })
  const weekStart = days[0].date
  return { weekStart, range: formatThaiWeekRange(weekStart), days, dueCount: days.reduce((n, d) => n + d.statuses.length, 0) }
}

/** Tasks due on one Bangkok date ('YYYY-MM-DD'), by due time. */
export function tasksDueOn(tasks: DashboardTask[], date: string): DashboardTask[] {
  return tasks.filter((t) => t.dueAt && bangkokDateLabel(new Date(t.dueAt)) === date).sort(byDue)
}

/** 'พุธ' style heading for a day list: 'พฤ. 12 พ.ย.' */
export function dayHeading(date: string): string {
  const d = new Date(`${date}T00:00:00+07:00`)
  const p = bangkokParts(d)
  return `${weekdayShort(d)} ${p.d} ${THAI_MONTHS_SHORT[p.m - 1]}`
}

// ---- Screen state ----
export type DashboardTab = 'overview' | 'calendar' | 'tasks'
export const TABS: { key: DashboardTab; label: string }[] = [
  { key: 'overview', label: 'ภาพรวม' },
  { key: 'calendar', label: 'ปฏิทิน' },
  { key: 'tasks', label: 'งานทั้งหมด' },
]

/** 'all' is the PM's comparison across groups; otherwise one group's id. */
export type Scope = 'all' | string

/** The PM's comparison needs a PM and at least two groups to compare. */
export function canCompare(data: DashboardData): boolean {
  return data.role === 'pm' && data.groups.length > 1
}

/** Where the screen starts: the group named by the link (the weekly insight's button
 *  carries groups.id) when the requester may see it, else the comparison for a PM,
 *  else the first group. */
export function initialScope(data: DashboardData, linkedGroupId: string | null): Scope {
  if (linkedGroupId && data.groups.some((g) => g.groupId === linkedGroupId)) return linkedGroupId
  if (canCompare(data)) return 'all'
  return data.groups[0]?.groupId ?? 'all'
}

export function errorCopy(status: number): string {
  if (status === 401) return 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
  if (status === 403) return 'ขอให้สมาชิกเชิญคุณเข้ากลุ่มใน LINE ก่อน จึงจะดูงานได้'
  return 'เชื่อมต่อไม่ได้ชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่'
}
