import type { ReviewView, Decision } from '@/server/review/types'

export type CandidateForm = {
  candidateId: string
  selected: boolean
  editable: boolean
  title: string
  details: string
  assigneeLineUserId: string | ''
  dueDate: string // 'YYYY-MM-DD'
  dueTime: string // 'HH:mm'
}

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000

export function toBangkokIso(date: string, time: string): string | null {
  if (!date) return null
  return `${date}T${time || '23:59'}:00+07:00`
}

export function splitBangkokIso(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' }
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return { date: '', time: '' }
  // Bangkok is fixed UTC+7 (no DST): shift, then read the UTC fields.
  const [date, time] = new Date(ms + BANGKOK_OFFSET_MS).toISOString().split('T')
  return { date, time: time.slice(0, 5) }
}

export function initialForms(view: ReviewView): CandidateForm[] {
  return view.candidates.map((c) => {
    const proposed = c.state === 'proposed'
    const { date, time } = splitBangkokIso(c.suggestedDueAt)
    return {
      candidateId: c.id,
      selected: proposed,
      editable: proposed,
      title: c.title,
      details: c.details ?? '',
      assigneeLineUserId: c.suggestedAssigneeLineUserId ?? '',
      dueDate: date,
      dueTime: time,
    }
  })
}

export function toDecisions(forms: CandidateForm[]): Decision[] {
  return forms
    .filter((f) => f.editable)
    .map((f): Decision =>
      f.selected
        ? {
            candidateId: f.candidateId,
            action: 'confirm',
            title: f.title.trim(),
            details: f.details === '' ? null : f.details,
            assigneeLineUserId: f.assigneeLineUserId === '' ? null : f.assigneeLineUserId,
            dueAt: toBangkokIso(f.dueDate, f.dueTime),
          }
        : { candidateId: f.candidateId, action: 'decline' },
    )
}

export function validateForms(forms: CandidateForm[]): string | null {
  const editable = forms.filter((f) => f.editable)
  if (editable.length === 0) return 'ไม่มีงานให้ยืนยันแล้ว'
  if (editable.some((f) => f.selected && f.title.trim() === '')) return 'กรุณาใส่ชื่องานให้ครบ'
  return null
}

export function countDecisions(forms: CandidateForm[]): { confirm: number; decline: number } {
  const decisions = toDecisions(forms)
  const confirm = decisions.filter((d) => d.action === 'confirm').length
  return { confirm, decline: decisions.length - confirm }
}

// Declines are final: a submit that would only decline must be confirmed first.
export function needsDeclineConfirm(counts: { confirm: number; decline: number }): boolean {
  return counts.confirm === 0 && counts.decline > 0
}
