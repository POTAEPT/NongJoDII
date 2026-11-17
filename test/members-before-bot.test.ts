import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMBERS_HINT, MembersHint } from '@/app/liff/members-hint'
import { parseGroupCommand } from '@/server/commands/parse'
import { HELLO_TEXT } from '@/server/commands/quick-reply'
import { loadSettings } from '@/server/settings/settings'
import { setupCard, SETUP_CARD_TEXT } from '@/server/setup/card'
import { loadSetup } from '@/server/setup/load'
import type { SettingsLoad } from '@/server/settings/types'
import type { SetupLoad } from '@/server/setup/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #142: LINE lists a group's members only for verified and premium accounts, so people who
// were in the group before the bot are unknown until they post. The form and Settings say
// how many are known out of LINE's member count, and the setup card asks everyone to say hi.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const LINE_GROUP = 'Cteam'

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { lineGroupId: LINE_GROUP, members: [{ lineUserId: 'Upim', displayName: 'Pim' }] })
  h.line.idTokens.set('tok-owner', { lineUserId: 'Uowner1', displayName: 'Owner' })
  h.line.groupMemberCounts.set(LINE_GROUP, 5)
  const send = async (...events: Parameters<typeof webhookBody>) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  return { ...h, group, send }
}

describe('LINE member count on the form and Settings (#142)', () => {
  it('the setup form and Settings carry LINE\'s count next to the known Members', async () => {
    const s = setup()
    const form = (await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.group.id })).body as SetupLoad
    expect(form.lineMemberCount).toBe(5)
    expect(form.members).toHaveLength(2)
    const settings = (await loadSettings(s.deps, { idToken: 'tok-owner', groupId: s.group.id })).body as SettingsLoad
    expect(settings.lineMemberCount).toBe(5)
  })

  it('a LINE failure leaves the count null and the page still loads', async () => {
    const s = setup()
    s.line.failMemberCount = true
    const res = await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.group.id })
    expect(res.status).toBe(200)
    expect((res.body as SetupLoad).lineMemberCount).toBeNull()
  })

  it('someone who posts once is known after that, with no reply from the bot', async () => {
    const s = setup()
    await s.send(ev.groupText({ groupId: LINE_GROUP, userId: 'Ubank', text: HELLO_TEXT }))
    expect(s.line.replies).toEqual([])
    const form = (await loadSetup(s.deps, { idToken: 'tok-owner', groupId: s.group.id })).body as SetupLoad
    expect(form.members.map((m) => m.lineUserId)).toContain('Ubank')
  })
})

describe('the hint on the page (#142)', () => {
  const html = (known: number, total: number | null) => {
    const el = MembersHint({ known, total })
    return el ? renderToStaticMarkup(el) : ''
  }

  it('says how many are known and why the rest are missing', () => {
    const out = html(2, 5)
    expect(out).toContain(MEMBERS_HINT.count(2, 5))
    expect(out).toContain(MEMBERS_HINT.why)
  })

  it('shows nothing when everyone is known, and the plain advice when the count is unknown', () => {
    expect(html(5, 5)).toBe('')
    expect(html(2, null)).toContain(MEMBERS_HINT.unknownTotal)
  })
})

describe('the setup card asks everyone to say hi (#142)', () => {
  it('has the line and a 👋 quick reply that is not a command', () => {
    const card = setupCard({ liffId: 'liff', groupId: 'g1' })
    expect(JSON.stringify(card)).toContain(SETUP_CARD_TEXT.everyone)
    expect(card.type === 'flex' && card.quickReply?.items.map((i) => i.action.text)).toContain(HELLO_TEXT)
    expect(parseGroupCommand(HELLO_TEXT)).toBeNull()
  })
})
