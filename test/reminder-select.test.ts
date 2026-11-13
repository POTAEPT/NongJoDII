import { describe, expect, it } from 'vitest'
import {
  MAX_REMINDER_ITEMS,
  type ReminderTask,
  reminderReasons,
  selectReminders,
} from '@/server/reminders/select'

// #44 (8b): which Tasks go into a group's daily post. Bangkok wall-clock times throughout;
// the tick runs at the group's reminder time, 09:00 on Monday 16 Nov 2026 here.

const bkk = (s: string) => new Date(`${s}+07:00`)
const NOW = bkk('2026-11-16T09:00:00')

let seq = 0
function task(p: Partial<ReminderTask> = {}): ReminderTask {
  seq += 1
  return {
    id: `t-${String(seq).padStart(3, '0')}`, title: `Task ${seq}`, status: 'in_process',
    assigneeLineUserId: 'Uowner1', dueAt: null,
    lastActivityAt: bkk('2026-11-15T12:00:00'), deletedAt: null,
    ...p,
  }
}

describe('reminderReasons', () => {
  it('flags nothing for an owned Task with no due date and recent activity', () => {
    expect(reminderReasons(task(), NOW)).toEqual([])
  })

  describe('due soon = today or tomorrow, by Bangkok date', () => {
    it('due later today', () => {
      expect(reminderReasons(task({ dueAt: bkk('2026-11-16T17:00:00') }), NOW)).toEqual(['due_today'])
    })

    it('due any time tomorrow, up to 23:59', () => {
      expect(reminderReasons(task({ dueAt: bkk('2026-11-17T00:00:00') }), NOW)).toEqual(['due_tomorrow'])
      expect(reminderReasons(task({ dueAt: bkk('2026-11-17T23:59:00') }), NOW)).toEqual(['due_tomorrow'])
    })

    it('not the day after tomorrow', () => {
      expect(reminderReasons(task({ dueAt: bkk('2026-11-18T00:00:00') }), NOW)).toEqual([])
    })

    it('uses the Bangkok date, not the UTC date', () => {
      // 01:00 Tuesday in Bangkok is still Monday 18:00 in UTC: it is due tomorrow.
      expect(reminderReasons(task({ dueAt: bkk('2026-11-17T01:00:00') }), NOW)).toEqual(['due_tomorrow'])
      // 23:30 Tuesday in Bangkok: still tomorrow.
      expect(reminderReasons(task({ dueAt: bkk('2026-11-17T23:30:00') }), bkk('2026-11-16T23:45:00'))).toEqual(['due_tomorrow'])
    })
  })

  describe('overdue', () => {
    it('due before now', () => {
      expect(reminderReasons(task({ dueAt: bkk('2026-11-14T17:00:00') }), NOW)).toEqual(['overdue'])
    })

    it('due earlier today counts as overdue, not due today', () => {
      expect(reminderReasons(task({ dueAt: bkk('2026-11-16T08:00:00') }), NOW)).toEqual(['overdue'])
    })

    it('due exactly now is not overdue yet', () => {
      expect(reminderReasons(task({ dueAt: NOW }), NOW)).toEqual(['due_today'])
    })
  })

  describe('no assignee', () => {
    it('a Task nobody owns', () => {
      expect(reminderReasons(task({ status: 'not_assigned', assigneeLineUserId: null }), NOW)).toEqual(['no_assignee'])
    })
  })

  describe('no update in 5 days', () => {
    it('more than 5 x 24 h since the last activity', () => {
      expect(reminderReasons(task({ lastActivityAt: bkk('2026-11-11T08:59:00') }), NOW)).toEqual(['no_update'])
    })

    it('exactly 5 x 24 h is not yet', () => {
      expect(reminderReasons(task({ lastActivityAt: bkk('2026-11-11T09:00:00') }), NOW)).toEqual([])
    })

    it('no activity time recorded is not flagged', () => {
      expect(reminderReasons(task({ lastActivityAt: null }), NOW)).toEqual([])
    })
  })

  it('never picks a Done or deleted Task, whatever else matches', () => {
    const stale = { dueAt: bkk('2026-11-01T09:00:00'), assigneeLineUserId: null, lastActivityAt: bkk('2026-10-01T09:00:00') }
    expect(reminderReasons(task({ ...stale, status: 'done' }), NOW)).toEqual([])
    expect(reminderReasons(task({ ...stale, deletedAt: bkk('2026-11-10T09:00:00') }), NOW)).toEqual([])
  })

  it('gives every reason that applies, most urgent first', () => {
    const t = task({
      status: 'not_assigned', assigneeLineUserId: null,
      dueAt: bkk('2026-11-15T17:00:00'), lastActivityAt: bkk('2026-11-01T09:00:00'),
    })
    expect(reminderReasons(t, NOW)).toEqual(['overdue', 'no_assignee', 'no_update'])
  })
})

describe('selectReminders', () => {
  it('lists each matching Task once, most urgent first, and skips the rest', () => {
    const quiet = task({ title: 'Quiet' })
    const unowned = task({ title: 'Unowned', status: 'not_assigned', assigneeLineUserId: null })
    const tomorrow = task({ title: 'Tomorrow', dueAt: bkk('2026-11-17T12:00:00') })
    const overdueAndUnowned = task({ title: 'Late', dueAt: bkk('2026-11-15T12:00:00'), assigneeLineUserId: null })
    const today = task({ title: 'Today', dueAt: bkk('2026-11-16T18:00:00') })
    const stale = task({ title: 'Stale', lastActivityAt: bkk('2026-11-01T09:00:00') })
    const done = task({ title: 'Done', status: 'done', dueAt: bkk('2026-11-15T12:00:00') })

    const { items, total } = selectReminders([quiet, unowned, tomorrow, overdueAndUnowned, today, stale, done], NOW)
    expect(items.map((i) => i.task.title)).toEqual(['Late', 'Today', 'Tomorrow', 'Unowned', 'Stale'])
    expect(items[0].reasons).toEqual(['overdue', 'no_assignee'])
    expect(total).toBe(5)
  })

  it('orders Tasks with the same top reason by due date, then by oldest activity', () => {
    const lateB = task({ title: 'B', dueAt: bkk('2026-11-14T12:00:00') })
    const lateA = task({ title: 'A', dueAt: bkk('2026-11-10T12:00:00') })
    const staleNewer = task({ title: 'D', lastActivityAt: bkk('2026-11-09T12:00:00') })
    const staleOlder = task({ title: 'C', lastActivityAt: bkk('2026-11-02T12:00:00') })
    const { items } = selectReminders([lateB, staleNewer, lateA, staleOlder], NOW)
    expect(items.map((i) => i.task.title)).toEqual(['A', 'B', 'C', 'D'])
  })

  it(`caps the post at ${MAX_REMINDER_ITEMS} Tasks and still counts every match`, () => {
    const tasks = Array.from({ length: 15 }, () => task({ status: 'not_assigned', assigneeLineUserId: null }))
    const { items, total } = selectReminders(tasks, NOW)
    expect(items).toHaveLength(MAX_REMINDER_ITEMS)
    expect(total).toBe(15)
  })

  it('returns nothing when no Task needs a reminder (the caller then sends nothing)', () => {
    expect(selectReminders([task(), task({ status: 'done' })], NOW)).toEqual({ items: [], total: 0 })
  })

  it('picks the same Task again the next day while it still matches', () => {
    const late = task({ dueAt: bkk('2026-11-15T12:00:00') })
    expect(selectReminders([late], NOW).total).toBe(1)
    expect(selectReminders([late], bkk('2026-11-17T09:00:00')).total).toBe(1)
  })

  it('moves a Task from tomorrow to today to overdue as the days pass', () => {
    const t = task({ dueAt: bkk('2026-11-17T12:00:00') })
    expect(reminderReasons(t, bkk('2026-11-16T09:00:00'))).toEqual(['due_tomorrow'])
    expect(reminderReasons(t, bkk('2026-11-17T09:00:00'))).toEqual(['due_today'])
    expect(reminderReasons(t, bkk('2026-11-18T09:00:00'))).toEqual(['overdue'])
  })
})
