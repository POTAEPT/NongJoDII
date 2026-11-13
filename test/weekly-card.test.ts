import { describe, expect, it } from 'vitest'
import { CARD_UNOWNED_SHOWN, WEEKLY_CARD_TEXT, shouldPostWeeklyInsight, weeklyInsightCard } from '@/server/insight/card'
import type { WeeklyInsight } from '@/server/insight/weekly'
import { formatThaiWeekRange } from '@/server/time/bangkok'

// #21: what the group sees in the weekly insight post. Reads the card's visible texts and
// its button, not its layout.

const LIFF_ID = '2000000000-abcdefgh'
const bkk = (s: string) => new Date(`${s}+07:00`)

function insight(p: Partial<WeeklyInsight> = {}): WeeklyInsight {
  return {
    groupId: 'g-1', lineGroupId: 'Cgroup1', weekStart: '2026-11-16',
    counts: { done: 2, inProcess: 1, awaitingOwner: 3 },
    unowned: [
      { id: 't1', title: 'Budget', dueAt: null },
      { id: 't2', title: 'Venue', dueAt: bkk('2026-11-20T17:00:00') },
      { id: 't3', title: 'Catering', dueAt: null },
    ],
    ...p,
  }
}

/** Every text in the Flex tree, in order. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  const own = o.type === 'text' && typeof o.text === 'string' ? [o.text] : []
  return [...own, ...Object.values(o).flatMap(texts)]
}

/** Every button action in the Flex tree. */
function actions(node: unknown): Array<{ type: string; label: string; uri?: string }> {
  if (Array.isArray(node)) return node.flatMap(actions)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  const own = o.type === 'button' ? [o.action as { type: string; label: string; uri?: string }] : []
  return [...own, ...Object.values(o).filter((v) => v !== o.action).flatMap(actions)]
}

function card(p: Parameters<typeof insight>[0] = {}, groupName: string | null = 'ทีมงานอีเวนต์') {
  const msg = weeklyInsightCard({ insight: insight(p), groupName, liffId: LIFF_ID })
  if (msg.type !== 'flex') throw new Error('expected a Flex message')
  return msg
}

describe('weekly insight card (#21)', () => {
  it('shows the week, the group name and the three counts', () => {
    const msg = card()
    const all = texts(msg.contents)
    expect(all).toContain(WEEKLY_CARD_TEXT.title)
    expect(all).toContain('ทีมงานอีเวนต์ · 16–22 พ.ย.')
    // Tile value followed by its label, in the order done, in progress, awaiting an owner.
    const tiles = all.slice(all.indexOf('ทีมงานอีเวนต์ · 16–22 พ.ย.') + 1, all.indexOf('ทีมงานอีเวนต์ · 16–22 พ.ย.') + 7)
    expect(tiles).toEqual(['2', 'เสร็จ', '1', 'กำลังทำ', '3', 'ยังไม่มีผู้รับ'])
  })

  it('lists the unowned Tasks with their due dates', () => {
    const all = texts(card().contents)
    expect(all).toContain(WEEKLY_CARD_TEXT.unownedHeader)
    expect(all).toContain('• Budget')
    expect(all).toContain('• Venue · ส่ง 20 พ.ย.')
    expect(all).toContain('• Catering')
    expect(all.some((t) => t.startsWith('และอีก'))).toBe(false)
  })

  it(`names at most ${CARD_UNOWNED_SHOWN} and counts the rest from the total, not the list`, () => {
    const unowned = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `Task ${i + 1}`, dueAt: null }))
    const all = texts(card({ counts: { done: 0, inProcess: 0, awaitingOwner: 13 }, unowned }).contents)
    expect(all.filter((t) => t.startsWith('• '))).toEqual(['• Task 1', '• Task 2', '• Task 3', '• Task 4', '• Task 5'])
    expect(all).toContain(WEEKLY_CARD_TEXT.more(8))
  })

  it('shortens a long Task title', () => {
    const long = 'ก'.repeat(60)
    const all = texts(card({ counts: { done: 0, inProcess: 0, awaitingOwner: 1 }, unowned: [{ id: 't', title: long, dueAt: null }] }).contents)
    const line = all.find((t) => t.startsWith('• ')) as string
    expect(line).toBe(`• ${'ก'.repeat(39)}…`)
  })

  it('says every Task has an owner when none is waiting', () => {
    const all = texts(card({ counts: { done: 4, inProcess: 2, awaitingOwner: 0 }, unowned: [] }).contents)
    expect(all).toContain(WEEKLY_CARD_TEXT.allOwned)
    expect(all).not.toContain(WEEKLY_CARD_TEXT.unownedHeader)
  })

  it('says the group has no Tasks yet when every count is zero', () => {
    const all = texts(card({ counts: { done: 0, inProcess: 0, awaitingOwner: 0 }, unowned: [] }).contents)
    expect(all).toContain(WEEKLY_CARD_TEXT.noTasks)
  })

  it('has one Open Dashboard button that links to the Dashboard by group ID only', () => {
    const buttons = actions(card().contents)
    expect(buttons).toEqual([
      { type: 'uri', label: WEEKLY_CARD_TEXT.openDashboard, uri: `https://liff.line.me/${LIFF_ID}?view=dashboard&id=g-1` },
    ])
    expect(buttons[0].uri).not.toContain('ทีมงาน')
  })

  it('leaves out the group name when it is unknown', () => {
    expect(texts(card({}, null).contents)).toContain('16–22 พ.ย.')
  })

  it('puts the counts in the notification text', () => {
    expect(card().altText).toBe(`${WEEKLY_CARD_TEXT.title}: เสร็จ 2 · กำลังทำ 1 · ยังไม่มีผู้รับ 3`)
  })
})

describe('shouldPostWeeklyInsight (#21)', () => {
  it('skips a group with no Tasks at all', () => {
    expect(shouldPostWeeklyInsight(insight({ counts: { done: 0, inProcess: 0, awaitingOwner: 0 }, unowned: [] }))).toBe(false)
  })

  it('posts when any count is above zero, even if every Task is Done', () => {
    expect(shouldPostWeeklyInsight(insight({ counts: { done: 3, inProcess: 0, awaitingOwner: 0 }, unowned: [] }))).toBe(true)
    expect(shouldPostWeeklyInsight(insight())).toBe(true)
  })
})

describe('formatThaiWeekRange', () => {
  it('writes one month once, and both months across a month end', () => {
    expect(formatThaiWeekRange('2026-11-16')).toBe('16–22 พ.ย.')
    expect(formatThaiWeekRange('2026-11-30')).toBe('30 พ.ย. – 6 ธ.ค.')
    expect(formatThaiWeekRange('2026-12-28')).toBe('28 ธ.ค. – 3 ม.ค.')
  })
})
