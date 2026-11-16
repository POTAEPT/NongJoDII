import { describe, expect, it } from 'vitest'
import { toMyProfileBody, validateMyRow } from '@/app/liff/settings-model'
import type { SetupForm } from '@/app/liff/setup-model'
import { NICKNAME_MAX, ROLE_MAX } from '@/server/setup/rules'

// #81: a Member who is not the Owner saves only their own row from Settings.

const form = (biw: { nicknames: string[]; role: string }): SetupForm => ({
  workDescription: 'งาน', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
  dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', ownerLineUserId: 'Uowner',
  members: [
    { lineUserId: 'Uowner', displayName: 'โอ๋', nicknames: ['x'.repeat(NICKNAME_MAX + 1)], role: 'หัวหน้า' },
    { lineUserId: 'Ubiw', displayName: 'บิว', ...biw },
  ],
} as SetupForm)

describe('a Member\'s own row in Settings (#81)', () => {
  it('sends only the requester\'s nicknames (cleaned) and role, never a person', () => {
    expect(toMyProfileBody(form({ nicknames: [' บิว ', '', 'Bew'], role: ' ออกแบบ ' }), 'Ubiw'))
      .toEqual({ nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' })
    expect(toMyProfileBody(form({ nicknames: [], role: '' }), 'Unobody')).toBeNull()
  })

  it('checks only the requester\'s row: another row\'s long nickname does not block it', () => {
    expect(validateMyRow(form({ nicknames: ['บิว'], role: 'ออกแบบ' }), 'Ubiw')).toBeNull()
    expect(validateMyRow(form({ nicknames: ['x'.repeat(NICKNAME_MAX + 1)], role: '' }), 'Ubiw')).not.toBeNull()
    expect(validateMyRow(form({ nicknames: [], role: 'x'.repeat(ROLE_MAX + 1) }), 'Ubiw')).not.toBeNull()
  })
})
