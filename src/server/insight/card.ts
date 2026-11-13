import type { LineMessage, LineUriAction } from '../line/types'
import { liffUrl } from '../liff-links'
import { formatThaiDayMonth, formatThaiWeekRange } from '../time/bangkok'
import type { WeeklyInsight } from './weekly'

// The weekly insight post (#21), after the Figma "Weekly summary card": Tasks done, in
// progress and awaiting an owner, the unowned Tasks and an Open Dashboard button. Counts
// come from code; there is no AI paragraph (decided 2026-11-11). Same look as the Track
// progress cards (progress/card.ts). Only IDs go into the Dashboard link (rules: Baseline).

const C = { text: '#14213D', muted: '#8A94A6', primary: '#1F5BAD', line: '#E6EAF0' } as const

/** Tiles in the order the card shows them; labels are the agreed UI status labels. */
const TILES = [
  { key: 'done', label: 'เสร็จ', bg: '#DDF3E6', fg: '#17703F' },
  { key: 'inProcess', label: 'กำลังทำ', bg: '#DCE8F7', fg: '#1F5BAD' },
  { key: 'awaitingOwner', label: 'ยังไม่มีผู้รับ', bg: '#FCEFC7', fg: '#7A4B00' },
] as const

/** How many unowned Tasks the card names; the rest are counted in one line. */
export const CARD_UNOWNED_SHOWN = 5
const TITLE_MAX = 40

export const WEEKLY_CARD_TEXT = {
  title: 'สรุปงานประจำสัปดาห์',
  unownedHeader: 'งานที่ยังไม่มีผู้รับ',
  allOwned: 'ทุกงานมีผู้รับแล้ว',
  noTasks: 'สัปดาห์นี้ยังไม่มีงานในกลุ่มนี้',
  more: (n: number) => `และอีก ${n} งาน`,
  due: (d: Date) => `ส่ง ${formatThaiDayMonth(d)}`,
  openDashboard: 'เปิด Dashboard',
} as const

function text(t: string, extra: Record<string, unknown> = {}) {
  return { type: 'text', text: t, wrap: true, color: C.text, size: 'sm', ...extra }
}

function clip(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title
}

function tile(label: string, value: number, bg: string, fg: string) {
  return {
    type: 'box', layout: 'vertical', backgroundColor: bg, cornerRadius: 'md', paddingAll: 'sm', spacing: 'xs',
    contents: [
      text(String(value), { size: 'xl', weight: 'bold', color: fg, align: 'center' }),
      text(label, { size: 'xxs', color: fg, align: 'center' }),
    ],
  }
}

function unownedLines(insight: WeeklyInsight): unknown[] {
  const total = insight.counts.done + insight.counts.inProcess + insight.counts.awaitingOwner
  if (total === 0) return [text(WEEKLY_CARD_TEXT.noTasks, { size: 'xs', color: C.muted })]
  if (insight.counts.awaitingOwner === 0) return [text(WEEKLY_CARD_TEXT.allOwned, { size: 'xs', color: C.muted })]

  const shown = insight.unowned.slice(0, CARD_UNOWNED_SHOWN)
  const lines: unknown[] = [text(WEEKLY_CARD_TEXT.unownedHeader, { weight: 'bold', size: 'sm' })]
  for (const t of shown) {
    const due = t.dueAt ? ` · ${WEEKLY_CARD_TEXT.due(t.dueAt)}` : ''
    lines.push(text(`• ${clip(t.title)}${due}`, { size: 'xs' }))
  }
  // The count, not the list length, decides "and N more": the list is capped (#20).
  const rest = insight.counts.awaitingOwner - shown.length
  if (rest > 0) lines.push(text(WEEKLY_CARD_TEXT.more(rest), { size: 'xs', color: C.muted }))
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
  return `${WEEKLY_CARD_TEXT.title}: เสร็จ ${done} · กำลังทำ ${inProcess} · ยังไม่มีผู้รับ ${awaitingOwner}`
}

/** One Flex message: header with the week, three count tiles, the unowned Tasks and the
 *  Open Dashboard button. `groupName` is the LINE group name when known. */
export function weeklyInsightCard(p: { insight: WeeklyInsight; groupName: string | null; liffId: string }): LineMessage {
  const { insight, groupName, liffId } = p
  const sub = [groupName, formatThaiWeekRange(insight.weekStart)].filter((x): x is string => !!x).join(' · ')
  const open: LineUriAction = {
    type: 'uri', label: WEEKLY_CARD_TEXT.openDashboard, uri: liffUrl(liffId, 'dashboard', insight.groupId),
  }
  return {
    type: 'flex',
    altText: weeklyInsightAltText(insight),
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg',
        contents: [
          {
            type: 'box', layout: 'vertical', spacing: 'xs',
            contents: [
              text(WEEKLY_CARD_TEXT.title, { weight: 'bold', size: 'md' }),
              text(sub, { size: 'xs', color: C.muted }),
            ],
          },
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: TILES.map((t) => tile(t.label, insight.counts[t.key], t.bg, t.fg)),
          },
          { type: 'separator', color: C.line },
          { type: 'box', layout: 'vertical', spacing: 'xs', contents: unownedLines(insight) },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: 'md',
        contents: [{ type: 'button', style: 'primary', color: C.primary, height: 'sm', action: open }],
      },
    },
  }
}
