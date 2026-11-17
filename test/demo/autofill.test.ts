import { describe, expect, it } from 'vitest'
import { DEMO_TAGS, demoAutofill, demoWorkDescription, fillSetupForm } from '@/app/demo/_lib/autofill'
import { toSubmitBody, validateAll, type SetupForm } from '@/app/liff/setup-model'
import type { SetupLoad } from '@/server/setup/types'

// "✨ เติมข้อมูลตัวอย่าง" in the demo's setup form fills only what is empty.

const NONT = { lineUserId: 'Unont', role: 'manager', nicknames: ['นนท์'] }
const JEFF = { lineUserId: 'Ujeff', role: 'marketing', nicknames: ['เจฟ'] }

const view = (groupName: string | null) => ({ groupName } as SetupLoad)

function blank(): SetupForm {
  return {
    workDescription: '', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
    members: [
      { lineUserId: 'Unont', displayName: 'Nont', nicknames: [], role: '' },
      { lineUserId: 'Ujeff', displayName: 'Jeff', nicknames: [''], role: '' },
      { lineUserId: 'Ustranger', displayName: 'Pim', nicknames: [], role: '' },
    ],
    ownerLineUserId: 'Unont', tagSet: [], attachProjectId: null,
  }
}

describe('demo setup autofill', () => {
  it('fills an empty form from the personas and the group name, and the result passes the form checks', () => {
    const out = fillSetupForm(blank(), view('ลูกค้า ร้านกาแฟ'), [NONT, JEFF])
    expect(out.workDescription).toBe('ทำแบรนด์และเพจให้ร้านกาแฟเปิดใหม่')
    expect(out.tagSet).toEqual(DEMO_TAGS)
    expect(out.members.map((m) => [m.nicknames, m.role])).toEqual([[['นนท์'], 'manager'], [['เจฟ'], 'marketing'], [[], '']])
    expect(validateAll(out)).toBeNull()
    expect(toSubmitBody(out).members[0]).toEqual({ lineUserId: 'Unont', nicknames: ['นนท์'], role: 'manager' })
  })

  it('keeps what was typed, and the Owner, times and attach choice', () => {
    const typed: SetupForm = {
      ...blank(), workDescription: 'งานของเรา', tagSet: ['ด่วน'], ownerLineUserId: 'Ujeff', attachProjectId: 'p1', dailyReminderTime: '18:00',
      members: [{ lineUserId: 'Unont', displayName: 'Nont', nicknames: ['พี่นนท์'], role: 'PM' }],
    }
    expect(fillSetupForm(typed, view('x'), [NONT])).toEqual(typed)
  })

  it('a group with another name gets a generic description; the provider wraps the same fill', () => {
    expect(demoWorkDescription('Test2')).toContain('Test2')
    expect(demoWorkDescription(null)).toContain('กลุ่มนี้')
    expect(demoAutofill([NONT]).setup!(blank(), view(null)).members[0].nicknames).toEqual(['นนท์'])
  })
})
