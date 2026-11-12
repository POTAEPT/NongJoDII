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

/** The Summary reply: names on it are LINE names only (rule 9). */
export function buildSummaryReply(p: {
  summaryText: string; candidates: ReplyCandidate[]; summaryId: string; liffId: string; draftTasks: boolean
}): LineMessage[] {
  const head = `สรุปแชทล่าสุด\n${p.summaryText}`
  if (!p.draftTasks) return [{ type: 'text', text: head.slice(0, TEXT_MAX) }]

  const n = p.candidates.length
  if (n === 0) return [{ type: 'text', text: `${head}\n\nไม่พบงานใหม่ในแชทช่วงนี้`.slice(0, TEXT_MAX) }]

  const items = p.candidates.map((c, i) => {
    const assignee = c.assignee === null ? 'ยังไม่มีผู้รับ' : (c.assignee.displayName ?? 'สมาชิก')
    const due = c.due ? formatThaiShort(c.due) : 'ไม่ระบุ'
    const lines = [`${i + 1}. ${c.title}`, `   ผู้รับ: ${assignee} · กำหนด: ${due}`]
    if (c.source) lines.push(`   จาก ${c.source.senderName ?? 'สมาชิก'} เวลา ${formatThaiShort(c.source.sentAt)}`)
    return lines.join('\n')
  })
  const text = `${head}\n\nงานที่พบ (${n})\n${items.join('\n')}`.slice(0, TEXT_MAX)

  return [
    { type: 'text', text },
    {
      type: 'template',
      altText: `สรุปแชท: พบ ${n} งาน`,
      template: {
        type: 'buttons',
        text: `พบ ${n} งาน กดเพื่อเลือก แก้ไข และยืนยันก่อนสร้างงาน`,
        actions: [{ type: 'uri', label: 'ตรวจและยืนยันงาน', uri: liffUrl(p.liffId, 'review', p.summaryId) }],
      },
    },
  ]
}
