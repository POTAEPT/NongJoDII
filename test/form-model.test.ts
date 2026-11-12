import { describe, expect, it } from 'vitest'
import type { ReviewView } from '@/server/review/types'
import {
  countDecisions,
  initialForms,
  needsDeclineConfirm,
  splitBangkokIso,
  toBangkokIso,
  toDecisions,
  validateForms,
  type CandidateForm,
} from '@/app/liff/form-model'

const view: ReviewView = {
  summaryId: 's1',
  summaryText: 'สรุป',
  candidates: [
    { id: 'c1', state: 'proposed', title: 'งานหนึ่ง', details: 'รายละเอียด', suggestedAssigneeLineUserId: 'U1', suggestedDueAt: '2026-11-21T02:00:00.000Z' },
    { id: 'c2', state: 'proposed', title: 'งานสอง', details: null, suggestedAssigneeLineUserId: null, suggestedDueAt: null },
    { id: 'c3', state: 'confirmed', title: 'งานสาม', details: null, suggestedAssigneeLineUserId: null, suggestedDueAt: null },
  ],
  members: [{ lineUserId: 'U1', displayName: 'Ann' }],
}

const form = (over: Partial<CandidateForm> = {}): CandidateForm => ({
  candidateId: 'c', selected: true, editable: true, title: 't', details: '', assigneeLineUserId: '', dueDate: '', dueTime: '', ...over,
})

describe('toBangkokIso', () => {
  it('joins date and time at +07:00', () => {
    expect(toBangkokIso('2026-11-21', '09:00')).toBe('2026-11-21T09:00:00+07:00')
  })
  it('defaults an empty time to end of day', () => {
    expect(toBangkokIso('2026-11-21', '')).toBe('2026-11-21T23:59:00+07:00')
  })
  it('gives null for an empty date', () => {
    expect(toBangkokIso('', '09:00')).toBeNull()
  })
})

describe('splitBangkokIso', () => {
  it('converts UTC to Bangkok wall clock', () => {
    expect(splitBangkokIso('2026-11-21T02:00:00.000Z')).toEqual({ date: '2026-11-21', time: '09:00' })
  })
  it('rolls the date over past midnight Bangkok', () => {
    expect(splitBangkokIso('2026-11-21T20:30:00.000Z')).toEqual({ date: '2026-11-22', time: '03:30' })
  })
  it('gives empty strings for null', () => {
    expect(splitBangkokIso(null)).toEqual({ date: '', time: '' })
  })
})

describe('initialForms', () => {
  it('makes proposed candidates selected and editable with suggestions filled', () => {
    const [a, b] = initialForms(view)
    expect(a).toEqual({ candidateId: 'c1', selected: true, editable: true, title: 'งานหนึ่ง', details: 'รายละเอียด', assigneeLineUserId: 'U1', dueDate: '2026-11-21', dueTime: '09:00' })
    expect(b).toMatchObject({ details: '', assigneeLineUserId: '', dueDate: '', dueTime: '' })
  })
  it('makes decided candidates read-only and unselected', () => {
    expect(initialForms(view)[2]).toMatchObject({ editable: false, selected: false })
  })
})

describe('toDecisions', () => {
  it('confirms selected editable forms with explicit nulls', () => {
    expect(toDecisions([form({ candidateId: 'a', title: '  ชื่อ  ' })])).toEqual([
      { candidateId: 'a', action: 'confirm', title: 'ชื่อ', details: null, assigneeLineUserId: null, dueAt: null },
    ])
  })
  it('carries details, assignee and due', () => {
    expect(toDecisions([form({ candidateId: 'a', details: 'x', assigneeLineUserId: 'U1', dueDate: '2026-11-21', dueTime: '09:00' })])).toEqual([
      { candidateId: 'a', action: 'confirm', title: 't', details: 'x', assigneeLineUserId: 'U1', dueAt: '2026-11-21T09:00:00+07:00' },
    ])
  })
  it('declines unselected editable forms and omits read-only ones', () => {
    expect(toDecisions([form({ candidateId: 'a', selected: false }), form({ candidateId: 'b', editable: false })])).toEqual([
      { candidateId: 'a', action: 'decline' },
    ])
  })
})

describe('validateForms', () => {
  it('rejects a selected editable form with an empty title', () => {
    expect(validateForms([form({ title: '  ' })])).toBe('กรุณาใส่ชื่องานให้ครบ')
  })
  it('ignores an empty title on an unselected form', () => {
    expect(validateForms([form({ title: '', selected: false })])).toBeNull()
  })
  it('rejects when nothing is editable', () => {
    expect(validateForms([form({ editable: false })])).toBe('ไม่มีงานให้ยืนยันแล้ว')
    expect(validateForms([])).toBe('ไม่มีงานให้ยืนยันแล้ว')
  })
})

describe('countDecisions', () => {
  it('counts what toDecisions would send', () => {
    const forms = [form(), form(), form({ selected: false }), form({ editable: false })]
    expect(countDecisions(forms)).toEqual({ confirm: 2, decline: 1 })
  })
})

describe('needsDeclineConfirm', () => {
  it('is true only when nothing is confirmed and something is declined', () => {
    expect(needsDeclineConfirm({ confirm: 0, decline: 2 })).toBe(true)
    expect(needsDeclineConfirm({ confirm: 1, decline: 2 })).toBe(false)
    expect(needsDeclineConfirm({ confirm: 2, decline: 0 })).toBe(false)
    expect(needsDeclineConfirm({ confirm: 0, decline: 0 })).toBe(false)
  })
})

describe('edit then submit', () => {
  it('edits #1, unselects #2', () => {
    const forms = initialForms({ ...view, candidates: view.candidates.slice(0, 2) })
    forms[0] = { ...forms[0], title: 'ชื่อใหม่' }
    forms[1] = { ...forms[1], selected: false }
    expect(toDecisions(forms)).toEqual([
      { candidateId: 'c1', action: 'confirm', title: 'ชื่อใหม่', details: 'รายละเอียด', assigneeLineUserId: 'U1', dueAt: '2026-11-21T09:00:00+07:00' },
      { candidateId: 'c2', action: 'decline' },
    ])
  })
})
