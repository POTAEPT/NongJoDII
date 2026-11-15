import { bubble, button, caption, column, header, panel, text, uri } from '../line/flex-ui'
import { liffUrl } from '../liff-links'
import type { LineMessage } from '../line/types'
import { formatThaiShort } from '../time/bangkok'

/** assignee null = no assignee; assignee.displayName null = an assignee whose LINE name is unknown (L1). */
export type ReplyCandidate = {
  title: string
  assignee: { displayName: string | null } | null
  due: Date | null
  source: { senderName: string | null; sentAt: Date } | null
}

const TEXT_MAX = 5000
const TITLE_MAX = 60

export const SUMMARY_TEXT = {
  head: 'สรุปแชตล่าสุด',
  none: 'ไม่พบงานใหม่ในแชตช่วงนี้',
  cardTitle: (n: number) => `สรุปจากแชต · พบ ${n} งาน`,
  altText: (n: number) => `สรุปแชต: พบ ${n} งาน`,
  review: 'ตรวจและยืนยันงาน',
  notYet: 'งานจะยังไม่ถูกสร้างจนกว่าจะกดยืนยัน',
} as const

function clip(t: string): string {
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t
}

/** The Summary reply (Figma UI v4 #3): the summary as text, then one card listing the
 *  proposed Tasks with the review button. Names on it are LINE names only (rule 9). */
export function buildSummaryReply(p: {
  summaryText: string; candidates: ReplyCandidate[]; summaryId: string; liffId: string; draftTasks: boolean
}): LineMessage[] {
  const head = `${SUMMARY_TEXT.head}\n${p.summaryText}`
  if (!p.draftTasks) return [{ type: 'text', text: head.slice(0, TEXT_MAX) }]

  const n = p.candidates.length
  if (n === 0) return [{ type: 'text', text: `${head}\n\n${SUMMARY_TEXT.none}`.slice(0, TEXT_MAX) }]

  const items = p.candidates.map((c) => {
    const assignee = c.assignee === null ? 'ยังไม่มีผู้รับ' : (c.assignee.displayName ?? 'สมาชิก')
    const due = c.due ? formatThaiShort(c.due) : 'ไม่ระบุ'
    const lines = [text(clip(c.title), { weight: 'bold' }), caption(`ผู้รับ: ${assignee} · กำหนด: ${due}`)]
    if (c.source) lines.push(caption(`จาก ${c.source.senderName ?? 'สมาชิก'} เวลา ${formatThaiShort(c.source.sentAt)}`))
    return column(lines, { spacing: 'none' })
  })

  return [
    { type: 'text', text: head.slice(0, TEXT_MAX) },
    {
      type: 'flex',
      altText: SUMMARY_TEXT.altText(n),
      contents: bubble(
        [header('info', SUMMARY_TEXT.cardTitle(n)), panel(items, { spacing: 'md' })],
        [
          button('primary', uri(SUMMARY_TEXT.review, liffUrl(p.liffId, 'review', p.summaryId))),
          caption(SUMMARY_TEXT.notYet, { size: 'xxs', align: 'center' }),
        ],
      ),
    },
  ]
}
