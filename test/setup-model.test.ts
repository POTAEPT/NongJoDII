import { describe, expect, it } from 'vitest'
import {
  addNickname, initialSetupForm, removeNickname, setNickname, setRole, stepForField, toSubmitBody, validateAll,
  validateStep,
} from '@/app/liff/setup-model'
import { cleanNicknames, isQuarterHour, NICKNAMES_PER_MEMBER_MAX, QUARTER_HOURS, WEEKDAYS } from '@/server/setup/rules'
import type { SetupLoad } from '@/server/setup/types'

function view(partial: Partial<SetupLoad> = {}): SetupLoad {
  return {
    groupId: 'g1', groupName: 'ทีม', state: 'open', requesterLineUserId: 'Ume',
    values: {
      workDescription: '', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', ownerLineUserId: null,
    },
    members: [
      { lineUserId: 'Ume', displayName: 'Me', nicknames: [], role: null },
      { lineUserId: 'Upim', displayName: 'Pim', nicknames: ['พิม'], role: 'ออกแบบ' },
    ],
    nominee: null,
    ...partial,
  }
}

describe('quarter-hour times', () => {
  it('lists 96 times from 00:00 to 23:45, every one a quarter hour', () => {
    expect(QUARTER_HOURS).toHaveLength(96)
    expect(QUARTER_HOURS[0]).toBe('00:00')
    expect(QUARTER_HOURS[37]).toBe('09:15')
    expect(QUARTER_HOURS[95]).toBe('23:45')
    expect(QUARTER_HOURS.every(isQuarterHour)).toBe(true)
  })
  it('rejects other minutes, seconds and bad shapes', () => {
    for (const t of ['09:10', '9:00', '24:00', '09:00:00', '', null, 900]) expect(isQuarterHour(t)).toBe(false)
  })
  it('weekday chips run Monday (1) to Sunday (7)', () => {
    expect(WEEKDAYS.map((d) => d.iso)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(WEEKDAYS.map((d) => d.label)).toEqual(['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'])
  })
})

describe('initialSetupForm', () => {
  it('prefills the defaults and makes the person filling in the form the Owner', () => {
    const f = initialSetupForm(view())
    expect(f.ownerLineUserId).toBe('Ume')
    expect(f.dailyReminderTime).toBe('09:00')
    expect(f.weeklySummaryWeekday).toBe(1)
    expect(f.features).toEqual({ summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true })
    expect(f.members[1]).toEqual({ lineUserId: 'Upim', displayName: 'Pim', nicknames: ['พิม'], role: 'ออกแบบ' })
  })
  it('keeps a listed nominee, and falls back to the requester when the nominee is gone', () => {
    const listed = view({ values: { ...view().values, ownerLineUserId: 'Upim' } })
    expect(initialSetupForm(listed).ownerLineUserId).toBe('Upim')
    const gone = view({ values: { ...view().values, ownerLineUserId: 'Uleft' } })
    expect(initialSetupForm(gone).ownerLineUserId).toBe('Ume')
  })
})

describe('nicknames and roles', () => {
  it('adds, edits and removes nickname inputs, up to the limit', () => {
    let f = initialSetupForm(view())
    f = addNickname(f, 'Ume')
    f = setNickname(f, 'Ume', 0, 'มี่')
    f = addNickname(f, 'Ume')
    f = setNickname(f, 'Ume', 1, 'Me')
    f = removeNickname(f, 'Ume', 0)
    expect(f.members[0].nicknames).toEqual(['Me'])
    for (let i = 0; i < 20; i++) f = addNickname(f, 'Ume')
    expect(f.members[0].nicknames).toHaveLength(NICKNAMES_PER_MEMBER_MAX)
  })
  it('the send body trims, drops empty and duplicate nicknames, and trims the role', () => {
    let f = initialSetupForm(view())
    f = { ...f, workDescription: '  ทำแอป  ' }
    f = setRole(f, 'Ume', '  PM ')
    f = addNickname(addNickname(addNickname(f, 'Ume'), 'Ume'), 'Ume')
    f = setNickname(setNickname(f, 'Ume', 0, ' มี่ '), 'Ume', 2, 'มี่')
    const body = toSubmitBody(f)
    expect(body.workDescription).toBe('ทำแอป')
    expect(body.members[0]).toEqual({ lineUserId: 'Ume', nicknames: ['มี่'], role: 'PM' })
    expect(body.ownerLineUserId).toBe('Ume')
    expect(cleanNicknames(['a', ' ', 'a ', 'b'])).toEqual(['a', 'b'])
  })
})

describe('validateStep', () => {
  it('passes the defaults on every step', () => {
    expect(validateAll(initialSetupForm(view()))).toBeNull()
  })
  it('step 1: at most 2000 characters', () => {
    const f = { ...initialSetupForm(view()), workDescription: 'ก'.repeat(2001) }
    expect(validateStep(f, 1)).not.toBeNull()
    expect(validateAll(f)?.step).toBe(1)
  })
  it('step 2: the Owner must be a listed Member, and long nicknames or roles are refused', () => {
    const f = initialSetupForm(view())
    expect(validateStep({ ...f, ownerLineUserId: 'Uother' }, 2)).not.toBeNull()
    expect(validateStep(setNickname(addNickname(f, 'Ume'), 'Ume', 0, 'x'.repeat(51)), 2)).not.toBeNull()
    expect(validateStep(setRole(f, 'Ume', 'x'.repeat(101)), 2)).not.toBeNull()
  })
  it('step 4: only quarter-hour times', () => {
    const f = { ...initialSetupForm(view()), dailyReminderTime: '09:10' }
    expect(validateStep(f, 4)).not.toBeNull()
    expect(validateAll(f)?.step).toBe(4)
  })
})

describe('stepForField', () => {
  it('sends a refused field to the step that owns it, with a message', () => {
    const steps = Object.fromEntries([
      'workDescription', 'members', 'ownerLineUserId', 'features',
      'dailyReminderTime', 'weeklySummaryWeekday', 'weeklySummaryTime',
    ].map((f) => [f, stepForField(f)?.step]))
    expect(steps).toEqual({
      workDescription: 1, members: 2, ownerLineUserId: 2, features: 3,
      dailyReminderTime: 4, weeklySummaryWeekday: 4, weeklySummaryTime: 4,
    })
    expect(stepForField('ownerLineUserId')?.message).toBe('คนที่เลือกเป็นเจ้าของบอทไม่ได้อยู่ในกลุ่มแล้ว กรุณาเลือกคนอื่น')
    expect(stepForField('weeklySummaryTime')?.message).toBe('กรุณาเลือกเวลาทีละ 15 นาที')
  })
  it('gives null for a field the form has no step for, or no field', () => {
    for (const f of ['groupId', 'idToken', undefined, null, 7]) expect(stepForField(f)).toBeNull()
  })
})
