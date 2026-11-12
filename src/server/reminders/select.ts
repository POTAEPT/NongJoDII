import type { TaskStatus } from '../ports'
import { bangkokTodayLabel } from '../time/bangkok'

// #44 (8b) Daily reminders and gap flags: which of a group's Tasks go into today's post.
// Pure: the caller passes the group's Tasks and the tick's instant. Rules from #8 and the
// owner's decisions on #8 (2026-11-13):
//   - due soon = due today or tomorrow, by Bangkok date
//   - overdue = due before now and not Done
//   - no assignee = nobody owns it
//   - no update in 5 days = last_activity_at more than 5 x 24 h before now
//   - Done and deleted Tasks are never picked
//   - a Task that still matches is picked again every day (the post repeats daily)
//   - a Task that matches several rules appears once, with every reason

export type ReminderTask = {
  id: string; title: string; status: TaskStatus
  assigneeLineUserId: string | null; dueAt: Date | null
  lastActivityAt: Date | null; deletedAt: Date | null
}

export type ReminderReason = 'overdue' | 'due_today' | 'due_tomorrow' | 'no_assignee' | 'no_update'

export type ReminderItem = { task: ReminderTask; reasons: ReminderReason[] }

/** LINE allows up to 12 bubbles in one Flex carousel, so one post holds at most this many. */
export const MAX_REMINDER_ITEMS = 12
export const NO_UPDATE_DAYS = 5
const DAY_MS = 86_400_000

/** Reason order, most urgent first. It orders each item's reasons and the items. */
const RANK: Record<ReminderReason, number> = {
  overdue: 0, due_today: 1, due_tomorrow: 2, no_assignee: 3, no_update: 4,
}

export function reminderReasons(task: ReminderTask, now: Date): ReminderReason[] {
  if (task.deletedAt !== null || task.status === 'done') return []
  const reasons: ReminderReason[] = []
  if (task.dueAt !== null) {
    if (task.dueAt.getTime() < now.getTime()) {
      reasons.push('overdue')
    } else {
      const due = bangkokTodayLabel(task.dueAt)
      if (due === bangkokTodayLabel(now)) reasons.push('due_today')
      else if (due === bangkokTodayLabel(new Date(now.getTime() + DAY_MS))) reasons.push('due_tomorrow')
    }
  }
  if (task.assigneeLineUserId === null) reasons.push('no_assignee')
  if (task.lastActivityAt !== null && now.getTime() - task.lastActivityAt.getTime() > NO_UPDATE_DAYS * DAY_MS) {
    reasons.push('no_update')
  }
  return reasons.sort((a, b) => RANK[a] - RANK[b])
}

/** Today's post for one group: matching Tasks, most urgent first, then earliest due, then
 *  oldest activity. `items` is capped at MAX_REMINDER_ITEMS; `total` counts every match so
 *  the post can say how many more there are. */
export function selectReminders(tasks: ReminderTask[], now: Date): { items: ReminderItem[]; total: number } {
  const matched = tasks
    .map((task) => ({ task, reasons: reminderReasons(task, now) }))
    .filter((item) => item.reasons.length > 0)
    .sort((a, b) =>
      RANK[a.reasons[0]] - RANK[b.reasons[0]]
      || (a.task.dueAt?.getTime() ?? Infinity) - (b.task.dueAt?.getTime() ?? Infinity)
      || (a.task.lastActivityAt?.getTime() ?? Infinity) - (b.task.lastActivityAt?.getTime() ?? Infinity)
      || a.task.id.localeCompare(b.task.id))
  return { items: matched.slice(0, MAX_REMINDER_ITEMS), total: matched.length }
}
