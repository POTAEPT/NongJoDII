import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemberRows, PENDING_OWNER_TEXT, PendingOwnerScreen } from '@/app/liff/settings-view'
import { TEST_LIFF_ID } from './harness'

// #80 on the Settings screen, rendered to HTML in Node (no browser): Settings opened from the
// setup-done card before the named Owner confirmed.

const GROUP = '44444444-4444-4444-4444-444444444444'
const html = (isRequester: boolean) => renderToStaticMarkup(createElement(PendingOwnerScreen, {
  pendingOwner: { lineUserId: 'Upim', displayName: 'Pim Sirin', isRequester },
  groupId: GROUP, groupName: 'โปรเจกต์ DII', liffId: TEST_LIFF_ID, onClose: () => {},
}))

describe('Settings while the Owner is pending (#80)', () => {
  it('tells anyone else whom the group waits for, with no way to confirm for them', () => {
    const out = html(false)
    expect(out).toContain(PENDING_OWNER_TEXT.waitTitle)
    expect(out).toContain(PENDING_OWNER_TEXT.wait('Pim Sirin'))
    expect(out).not.toContain('view=owner')
  })

  it('sends the nominee to the Owner confirm page of this group', () => {
    const out = html(true)
    expect(out).toContain(PENDING_OWNER_TEXT.youTitle)
    expect(out).toContain(PENDING_OWNER_TEXT.you('โปรเจกต์ DII'))
    expect(out).toContain(`href="https://liff.line.me/${TEST_LIFF_ID}?view=owner&amp;id=${GROUP}"`)
  })
})

// #81: the "ชื่อเล่นและหน้าที่" list, for a Member and for the Owner.
describe('nicknames and roles in Settings (#81)', () => {
  const members = [
    { lineUserId: 'Ubiw', displayName: 'บิว', nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' },
    { lineUserId: 'Uowner', displayName: 'โอ๋', nicknames: ['โอ๋'], role: 'หัวหน้า' },
    { lineUserId: 'Uton', displayName: 'ต้น', nicknames: [], role: '' },
  ]
  const form = {
    workDescription: '', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', ownerLineUserId: 'Uowner', members,
  } as Parameters<typeof MemberRows>[0]['form']
  const rows = (me: string, canEdit: boolean) =>
    renderToStaticMarkup(createElement(MemberRows, { rows: members, me, canEdit, saving: false, form, onChange: () => {} }))
  const inputsOf = (out: string) => (out.match(/<input /g) ?? []).length

  it('a Member sees everyone\'s nicknames and roles and gets inputs only on their own row', () => {
    const out = rows('Ubiw', false)
    expect(out).toContain('คุณ')
    for (const s of ['โอ๋', 'หัวหน้า', 'ยังไม่มีชื่อเล่น']) expect(out).toContain(s) // others, read-only
    // Own row: two nickname inputs and one role input; nobody else's row has any.
    expect(inputsOf(out)).toBe(3)
    expect(out).toContain('value="Bew"')
    expect(out).toContain('value="ออกแบบ"')
    expect(out).not.toContain('value="หัวหน้า"')
  })

  it('the Owner still gets inputs on every row', () => {
    const out = rows('Uowner', true)
    expect(inputsOf(out)).toBe(2 + 1 + 1 + 1 + 0 + 1) // บิว 2+1, โอ๋ 1+1, ต้น 0+1
    expect(out).toContain('value="หัวหน้า"')
    expect(out).not.toContain('ยังไม่มีชื่อเล่น')
  })
})
