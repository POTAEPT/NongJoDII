import { caption, column, bubble, button, separator, text, uri } from '../line/flex-ui'
import { pushToGroupWithinBudget, retryKeyFrom } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log, logError } from '../log'
import type { Deps } from '../ports'
import { NO_UPDATE_DAYS } from '../reminders/select'
import { bangkokWeekStartLabel, formatThaiWeekRange } from '../time/bangkok'

// #120 A per-person weekly card for the Owner, in the 1:1 chat. The group card (#21) stays
// as it is and everyone sees it; this one goes only to the Project's owner.
//
// When: right after the Project's main group saves its weekly insight (that group's weekly
// slot), once per Project per week (ledger row owner_insight:<projectId>:<weekStart>).
// What, per Member across the Project's groups: Tasks in process, done this week, overdue,
// and with no update for more than NO_UPDATE_DAYS (the gap-flag rule). People with overdue
// or stale Tasks come first. Counts come from code; no AI. LINE names only.
// Cost: one 1:1 push (LINE counts one message), through the push budget, skipped near the
// quota. An Owner who is not a friend of the OA gets a 4xx from LINE: logged, nothing else.

export const OWNER_INSIGHT_TEXT = {
  title: 'สรุปรายคนสัปดาห์นี้',
  line: (p: { inProcess: number; doneThisWeek: number; overdue: number; stale: number }) =>
    [`กำลังทำ ${p.inProcess}`, `เสร็จ ${p.doneThisWeek}`, ...(p.overdue > 0 ? [`เลยกำหนด ${p.overdue}`] : []),
      ...(p.stale > 0 ? [`ไม่อัปเดตเกิน ${NO_UPDATE_DAYS} วัน ${p.stale}`] : [])].join(' · '),
  unowned: (n: number) => `ยังไม่มีผู้รับ ${n} งาน`,
  more: (n: number) => `และอีก ${n} คน`,
  nobody: 'สัปดาห์นี้ยังไม่มีงานที่มีผู้รับ',
  openDashboard: 'เปิด Dashboard',
} as const

/** How many people the card names; the rest are counted in one line. */
export const OWNER_CARD_PEOPLE_SHOWN = 10
export const OWNER_INSIGHT_RESERVE = 0.1
/** listTasksForSummary reads open Tasks first; this cap keeps the read small. */
const TASKS_READ_LIMIT = 200
const DAY_MS = 86_400_000
const FALLBACK_NAME = 'สมาชิก LINE'

export type PersonLine = { lineUserId: string; name: string; inProcess: number; doneThisWeek: number; overdue: number; stale: number }
export type OwnerInsight = { projectId: string; mainGroupId: string; weekStart: string; people: PersonLine[]; unowned: number }

function weekStartInstant(weekStart: string): Date {
  // Monday 00:00 Bangkok of that week.
  return new Date(`${weekStart}T00:00:00+07:00`)
}

/** The numbers for one Project as of `now`. */
export async function buildOwnerInsight(deps: Deps, projectId: string, mainGroupId: string, now: Date): Promise<OwnerInsight> {
  const weekStart = bangkokWeekStartLabel(now)
  const since = weekStartInstant(weekStart)
  const groups = (await deps.store.listProjectGroups([projectId])).map((g) => g.groupId)
  const [members, perGroup] = await Promise.all([
    deps.store.listDashboardMembers(groups),
    Promise.all(groups.map(async (g) => ({
      open: await deps.store.listReminderTasks(g),
      recent: await deps.store.listTasksForSummary(g, since, TASKS_READ_LIMIT),
    }))),
  ])
  const people = new Map<string, PersonLine>()
  const person = (id: string): PersonLine => {
    let p = people.get(id)
    if (!p) {
      const name = members.find((m) => m.lineUserId === id)?.displayName ?? FALLBACK_NAME
      p = { lineUserId: id, name, inProcess: 0, doneThisWeek: 0, overdue: 0, stale: 0 }
      people.set(id, p)
    }
    return p
  }
  let unowned = 0
  for (const { open, recent } of perGroup) {
    for (const t of open) {
      if (t.deletedAt !== null) continue
      if (t.assigneeLineUserId === null) { unowned++; continue }
      const p = person(t.assigneeLineUserId)
      p.inProcess++
      if (t.dueAt !== null && t.dueAt.getTime() < now.getTime()) p.overdue++
      if (t.lastActivityAt !== null && now.getTime() - t.lastActivityAt.getTime() > NO_UPDATE_DAYS * DAY_MS) p.stale++
    }
    // Done since Monday: listTasksForSummary keeps Done Tasks whose done_at or last activity
    // is at or after `since`.
    for (const t of recent) if (t.status === 'done' && t.assigneeLineUserId !== null) person(t.assigneeLineUserId).doneThisWeek++
  }
  const sorted = [...people.values()].sort((a, b) =>
    (b.overdue + b.stale) - (a.overdue + a.stale) || b.inProcess - a.inProcess || a.name.localeCompare(b.name, 'th'))
  return { projectId, mainGroupId, weekStart, people: sorted, unowned }
}

export function ownerInsightCard(p: { insight: OwnerInsight; projectName: string | null; liffId: string }): LineMessage {
  const { insight } = p
  const shown = insight.people.slice(0, OWNER_CARD_PEOPLE_SHOWN)
  const rows: Record<string, unknown>[] = shown.length === 0
    ? [caption(OWNER_INSIGHT_TEXT.nobody)]
    : shown.map((x) => column([text(x.name, { weight: 'bold' }), caption(OWNER_INSIGHT_TEXT.line(x))], { spacing: 'none', paddingTop: 'sm' }))
  const rest = insight.people.length - shown.length
  if (rest > 0) rows.push(caption(OWNER_INSIGHT_TEXT.more(rest)))
  const sub = [p.projectName, formatThaiWeekRange(insight.weekStart)].filter((x): x is string => !!x).join(' · ')
  return {
    type: 'flex',
    altText: `${OWNER_INSIGHT_TEXT.title}: ${insight.people.length} คน · ${OWNER_INSIGHT_TEXT.unowned(insight.unowned)}`,
    contents: bubble(
      [
        column([text(OWNER_INSIGHT_TEXT.title, { weight: 'bold', size: 'md' }), caption(sub)], { spacing: 'xs' }),
        column(rows, { spacing: 'none' }),
        separator(),
        caption(OWNER_INSIGHT_TEXT.unowned(insight.unowned)),
      ],
      [button('primary', uri(OWNER_INSIGHT_TEXT.openDashboard, liffUrl(p.liffId, 'dashboard', insight.mainGroupId)))],
    ),
  }
}

export function ownerInsightKey(projectId: string, weekStart: string): string {
  return `owner_insight:${projectId}:${weekStart}`
}

export type OwnerInsightResult = 'not_main' | 'no_owner' | 'empty' | 'already_sent' | 'pushed' | 'skipped_quota' | 'failed'

/** Sends the Owner card for the Project whose main group is `groupId`. Other groups do
 *  nothing. Never throws: the group insight is already saved and posted. */
export async function postOwnerInsight(deps: Deps, groupId: string, now: Date): Promise<OwnerInsightResult> {
  try {
    const group = await deps.store.getGroupById(groupId)
    if (!group?.projectId) return 'not_main'
    const ctx = await deps.store.getDriveContext(group.projectId)
    if (!ctx || ctx.mainGroup?.groupId !== groupId) return 'not_main'
    // Paused while the Owner left (#30): owner_confirmed_at is cleared.
    if (group.ownerConfirmedAt === null) return 'no_owner'
    const insight = await buildOwnerInsight(deps, ctx.projectId, groupId, now)
    if (insight.people.length === 0 && insight.unowned === 0) return 'empty'
    const { inserted } = await deps.store.recordWebhookEvent({
      webhookEventId: ownerInsightKey(ctx.projectId, insight.weekStart), eventType: 'owner_insight',
      lineGroupId: group.lineGroupId, eventTimestamp: now, isRedelivery: false,
    })
    if (!inserted) return 'already_sent'
    const result = await pushToGroupWithinBudget(deps, {
      purpose: 'owner_insight', groupId, lineGroupId: ctx.ownerLineUserId, recipients: 1,
      messages: [ownerInsightCard({ insight, projectName: group.name, liffId: deps.config.liffId })],
      reserve: OWNER_INSIGHT_RESERVE, retryKey: retryKeyFrom(ownerInsightKey(ctx.projectId, insight.weekStart)),
    })
    log('owner_insight', { projectId: ctx.projectId, result, people: insight.people.length })
    return result
  } catch (err) {
    logError('owner_insight_failed', { groupId }, err)
    return 'failed'
  }
}
