import { COLOR, STATUS, badge, bubble, button, caption, column, separator, text, uri } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { formatThaiDayMonth, formatThaiWeekRange } from '../time/bangkok'
import type { WeeklyInsight } from './weekly'

// The weekly insight post (#21), after the Figma "UI v4" frame #7-1 สรุปรายสัปดาห์: count
// tiles (ยังไม่มีผู้รับ, กำลังทำ, เสร็จ), the unowned Tasks to follow up and an Open Dashboard
// button. Counts come from code; there is no AI paragraph (decided 2026-11-11). Only IDs go
// into the Dashboard link (rules: Baseline).

/** Tiles in the order the card shows them (Figma Stat Tile), with the agreed status labels. */
const TILES = [
  { key: 'awaitingOwner', status: 'not_assigned' },
  { key: 'inProcess', status: 'in_process' },
  { key: 'done', status: 'done' },
] as const

/** How many unowned Tasks the card names; the rest are counted in one line. */
export const CARD_UNOWNED_SHOWN = 5
const TITLE_MAX = 40

export const WEEKLY_CARD_TEXT = {
  title: 'สรุปสัปดาห์นี้',
  unownedHeader: 'ต้องตามต่อ',
  allOwned: 'ทุกงานมีผู้รับแล้ว',
  noTasks: 'สัปดาห์นี้ยังไม่มีงานในกลุ่มนี้',
  more: (n: number) => `และอีก ${n} งาน`,
  due: (d: Date) => `ส่ง ${formatThaiDayMonth(d)}`,
  openDashboard: 'เปิด Dashboard',
} as const

function clip(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

/** Figma Stat Tile: a dot and label on top, the count below in the status colour. */
function tile(status: (typeof TILES)[number]['status'], value: number) {
  const s = STATUS[status]
  return {
    type: 'box', layout: 'vertical', flex: 1, cornerRadius: 'md', borderWidth: '1px', borderColor: COLOR.line,
    paddingAll: 'sm', spacing: 'xs',
    contents: [
      {
        type: 'box', layout: 'horizontal', spacing: 'xs', alignItems: 'center',
        contents: [
          { type: 'text', text: '●', flex: 0, size: 'xxs', color: s.dot },
          { type: 'text', text: s.label, size: 'xxs', color: COLOR.ink2, wrap: true },
        ],
      },
      { type: 'text', text: String(value), size: 'xl', weight: 'bold', color: s.fg },
    ],
  }
}

/** One unowned Task: title and due date on the left, the status badge on the right. */
function taskRow(title: string, due: Date | null) {
  return {
    type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', paddingTop: 'sm', paddingBottom: 'sm',
    contents: [
      column([text(clip(title), { weight: 'bold' }), ...(due ? [caption(WEEKLY_CARD_TEXT.due(due))] : [])], { spacing: 'none', flex: 1 }),
      badge('not_assigned'),
    ],
  }
}

function unownedLines(insight: WeeklyInsight): unknown[] {
  const total = insight.counts.done + insight.counts.inProcess + insight.counts.awaitingOwner
  if (total === 0) return [caption(WEEKLY_CARD_TEXT.noTasks)]
  if (insight.counts.awaitingOwner === 0) return [caption(WEEKLY_CARD_TEXT.allOwned)]

  const shown = insight.unowned.slice(0, CARD_UNOWNED_SHOWN)
  const lines: unknown[] = [caption(WEEKLY_CARD_TEXT.unownedHeader)]
  for (const t of shown) lines.push(taskRow(t.title, t.dueAt))
  // The count, not the list length, decides "and N more": the list is capped (#20).
  const rest = insight.counts.awaitingOwner - shown.length
  if (rest > 0) lines.push(caption(WEEKLY_CARD_TEXT.more(rest)))
  return lines
}

/** A group with no live Tasks at all gets no post: an all-zero card costs one LINE
 *  message per member and says nothing (decided by the #21 owner, 2026-11-13). */
export function shouldPostWeeklyInsight(insight: WeeklyInsight): boolean {
  const { done, inProcess, awaitingOwner } = insight.counts
  return done + inProcess + awaitingOwner > 0
}

/** The altText LINE shows in the chat list and notifications. */
export function weeklyInsightAltText(insight: WeeklyInsight): string {
  const { done, inProcess, awaitingOwner } = insight.counts
  return `${WEEKLY_CARD_TEXT.title}: ยังไม่มีผู้รับ ${awaitingOwner} · กำลังทำ ${inProcess} · เสร็จ ${done}`
}

/** One Flex message: header with the week, three count tiles, the unowned Tasks and the
 *  Open Dashboard button. `groupName` is the LINE group name when known. */
export function weeklyInsightCard(p: { insight: WeeklyInsight; groupName: string | null; liffId: string }): LineMessage {
  const { insight, groupName, liffId } = p
  const sub = [groupName, formatThaiWeekRange(insight.weekStart)].filter((x): x is string => !!x).join(' · ')
  const open = uri(WEEKLY_CARD_TEXT.openDashboard, liffUrl(liffId, 'dashboard', insight.groupId))
  return {
    type: 'flex',
    altText: weeklyInsightAltText(insight),
    contents: bubble(
      [
        column([text(WEEKLY_CARD_TEXT.title, { weight: 'bold', size: 'md' }), caption(sub)], { spacing: 'xs' }),
        { type: 'box', layout: 'horizontal', spacing: 'sm', contents: TILES.map((t) => tile(t.status, insight.counts[t.key])) },
        separator(),
        column(unownedLines(insight) as Record<string, unknown>[], { spacing: 'none' }),
      ],
      [button('primary', open)],
    ),
  }
}
