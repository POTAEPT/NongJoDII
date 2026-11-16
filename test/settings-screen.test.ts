import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PENDING_OWNER_TEXT, PendingOwnerScreen } from '@/app/liff/settings-view'
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
