import { describe, expect, it } from 'vitest'
import { REMINDER_TEXT, reasonLabel, reminderCarousel } from '@/server/reminders/card'
import { parseReminderAction } from '@/server/reminders/postback'
import { parseProgressAction } from '@/server/progress/postback'
import { MAX_REMINDER_ITEMS, type ReminderTask, selectReminders } from '@/server/reminders/select'

// #44 (8b): what the group sees in the daily reminder post, and the button data #45 reads.
// Reads visible texts and button actions, not layout.

const bkk = (s: string) => new Date(`${s}+07:00`)
const NOW = bkk('2026-11-16T09:00:00')

let seq = 0
function task(p: Partial<ReminderTask> = {}): ReminderTask {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, title: `Task ${seq}`, status: 'in_process',
    assigneeLineUserId: 'Ubew', dueAt: null, lastActivityAt: bkk('2026-11-15T12:00:00'), deletedAt: null,
    ...p,
  }
}

const NAMES = new Map<string, string | null>([['Ubew', 'บิว'], ['Uton', 'ต้น']])

function carousel(tasks: ReminderTask[], now = NOW) {
  const { items, total } = selectReminders(tasks, now)
  const msg = reminderCarousel({ items, total, names: NAMES, now })
  if (msg.type !== 'flex') throw new Error('expected Flex')
  const bubbles = (msg.contents as { type: string; contents: unknown[] })
  return { msg, bubbles: bubbles.contents, type: bubbles.type }
}

function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  const own = o.type === 'text' && typeof o.text === 'string' ? [o.text] : []
  return [...own, ...Object.values(o).flatMap(texts)]
}

function actions(node: unknown): Array<{ type: string; label: string; data: string }> {
  if (Array.isArray(node)) return node.flatMap(actions)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  const own = o.type === 'button' ? [o.action as { type: string; label: string; data: string }] : []
  return [...own, ...Object.values(o).filter((v) => v !== o.action).flatMap(actions)]
}

describe('daily reminder carousel (#44)', () => {
  it('is one carousel: a summary first, then one bubble per Task, most urgent first', () => {
    const late = task({ title: 'ส่งรายงาน', dueAt: bkk('2026-11-14T17:00:00') })
    const unowned = task({ title: 'จองห้อง', status: 'not_assigned', assigneeLineUserId: null })
    const tomorrow = task({ title: 'ทำสไลด์', dueAt: bkk('2026-11-17T12:00:00') })
    const { type, bubbles } = carousel([unowned, tomorrow, late])
    expect(type).toBe('carousel')
    expect(bubbles).toHaveLength(4)
    expect(texts(bubbles[0])).toEqual([
      REMINDER_TEXT.title, '16/11 · 3 งานที่ต้องดู',
      '• เลยกำหนด 1 งาน', '• ครบกำหนดวันนี้-พรุ่งนี้ 1 งาน', '• ยังไม่มีผู้รับ 1 งาน',
    ])
    expect(texts(bubbles[1])[0]).toBe('ส่งรายงาน')
    expect(texts(bubbles[2])[0]).toBe('ทำสไลด์')
    expect(texts(bubbles[3])[0]).toBe('จองห้อง')
  })

  it('shows the status, every reason and the owner by LINE name', () => {
    const t = task({ title: 'ส่งรายงาน', dueAt: bkk('2026-11-14T17:00:00'), lastActivityAt: bkk('2026-11-08T09:00:00') })
    const { bubbles } = carousel([t])
    expect(texts(bubbles[1])).toEqual(['ส่งรายงาน', '● กำลังทำ', 'เลยกำหนด 2 วัน', 'ไม่มีอัปเดต 8 วัน', 'คนทำ: บิว'])
  })

  it('says a Task has no owner yet', () => {
    const { bubbles } = carousel([task({ title: 'จองห้อง', status: 'not_assigned', assigneeLineUserId: null })])
    expect(texts(bubbles[1])).toEqual(['จองห้อง', '● ยังไม่มีผู้รับ', 'ยังไม่มีผู้รับ', REMINDER_TEXT.noOwner])
  })

  it('gives each Task a Postpone and a Done button that #45 can read back', () => {
    const t = task({ dueAt: bkk('2026-11-16T17:00:00') })
    const buttons = actions(carousel([t]).bubbles[1])
    expect(buttons.map((b) => b.label)).toEqual([REMINDER_TEXT.postpone, REMINDER_TEXT.done])
    expect(buttons.every((b) => b.type === 'postback')).toBe(true)
    expect(buttons.map((b) => parseReminderAction(b.data))).toEqual([
      { kind: 'postpone', taskId: t.id }, { kind: 'done', taskId: t.id },
    ])
    // The progress cards' parser (#39) does not take them for its own.
    expect(buttons.map((b) => parseProgressAction(b.data))).toEqual([null, null])
  })

  it('carries only the Task ID in the button data, never its title', () => {
    const t = task({ title: 'ความลับของลูกค้า', dueAt: bkk('2026-11-16T17:00:00') })
    for (const b of actions(carousel([t]).bubbles[1])) expect(b.data).not.toContain('ความลับ')
  })

  it(`names at most ${MAX_REMINDER_ITEMS} Tasks and says how many more are on the Dashboard`, () => {
    const tasks = Array.from({ length: MAX_REMINDER_ITEMS + 4 }, () => task({ status: 'not_assigned', assigneeLineUserId: null }))
    const { msg, bubbles } = carousel(tasks)
    expect(bubbles).toHaveLength(1 + MAX_REMINDER_ITEMS) // LINE allows 12 bubbles
    expect(texts(bubbles[0])).toContain(REMINDER_TEXT.more(4))
    expect(msg.altText).toBe(`${REMINDER_TEXT.title}: ยังไม่มีผู้รับ ${MAX_REMINDER_ITEMS} (+4)`)
  })

  it('sums the day up in the notification text', () => {
    const { msg } = carousel([
      task({ dueAt: bkk('2026-11-14T17:00:00') }),
      task({ dueAt: bkk('2026-11-16T17:00:00') }),
      task({ dueAt: bkk('2026-11-17T17:00:00') }),
      task({ status: 'not_assigned', assigneeLineUserId: null }),
    ])
    expect(msg.altText).toBe(`${REMINDER_TEXT.title}: เลยกำหนด 1 · ใกล้ครบกำหนด 2 · ยังไม่มีผู้รับ 1`)
  })

  it('refuses an empty day: nothing should be sent then', () => {
    expect(() => reminderCarousel({ items: [], total: 0, names: NAMES, now: NOW })).toThrow()
  })
})

describe('reasonLabel', () => {
  const item = (t: ReminderTask) => selectReminders([t], NOW).items[0]

  it('counts overdue days by Bangkok date', () => {
    const t = task({ dueAt: bkk('2026-11-15T23:30:00') })
    expect(reasonLabel('overdue', item(t), NOW)).toBe('เลยกำหนด 1 วัน')
  })

  it('shows the time for a Task due earlier today', () => {
    const t = task({ dueAt: bkk('2026-11-16T08:00:00') })
    expect(reasonLabel('overdue', item(t), NOW)).toBe('เลยกำหนดแล้ว (08:00)')
  })

  it('shows the due time for today and tomorrow', () => {
    expect(reasonLabel('due_today', item(task({ dueAt: bkk('2026-11-16T17:00:00') })), NOW)).toBe('ครบกำหนดวันนี้ 17:00')
    expect(reasonLabel('due_tomorrow', item(task({ dueAt: bkk('2026-11-17T09:30:00') })), NOW)).toBe('ครบกำหนดพรุ่งนี้ 09:30')
  })
})

describe('parseReminderAction', () => {
  it('rejects anything that is not a reminder button', () => {
    expect(parseReminderAction('a=pg&p=x&v=y')).toBeNull()
    expect(parseReminderAction('a=rd&t=not-a-uuid')).toBeNull()
    expect(parseReminderAction('a=rx&t=00000000-0000-4000-8000-000000000001')).toBeNull()
    expect(parseReminderAction('')).toBeNull()
  })
})
