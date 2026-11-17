import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formKey, isSettingsDirty } from '@/app/liff/settings-model'
import { FEATURES, OWNER_ROLE, OwnerRoleNote, TAG_SET_COPY, TIMES_COPY } from '@/app/liff/setup-parts'
import type { SetupForm } from '@/app/liff/setup-model'
import type { LineMessage } from '@/server/line/types'
import { SETUP_CARD_TEXT, SETUP_DONE_TEXT, setupCard, setupDoneCard, type SetupRecap } from '@/server/setup/card'
import { loadSetup } from '@/server/setup/load'
import { submitSetup } from '@/server/setup/submit'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, webhookBody } from './harness'

// #143: setup and Settings UX from E2E round 1: say what the bot Owner is, what the tag set
// is for, what each time posts (and that it does nothing while its feature is off), make the
// Owner choice look like a choice, keep Save off until something changes, and repeat the
// saved values on the setup-done card.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const json = (m: LineMessage) => JSON.stringify(m)

const RECAP: SetupRecap = {
  workDescription: 'ทำแอปส่งอาจารย์ วิชา Software Engineering ปี 3 เทอม 1 ส่งงานทุกวันศุกร์ และนำเสนอปลายภาค',
  tagSet: ['ออกแบบ', 'เอกสาร'],
  features: { summarize: true, draftTasks: true, saveFiles: true, trackRemind: true, weeklySummary: false },
  dailyReminderTime: '08:45', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
}

describe('the setup-done card repeats what was saved (#143)', () => {
  it('shows the work, the tags, the daily time and an off weekly post, with what each one is', () => {
    const card = json(setupDoneCard({ liffId: 'liff', groupId: 'g1', pendingOwnerName: null, recap: RECAP }))
    expect(card).toContain(SETUP_DONE_TEXT.recapTitle)
    expect(card).toContain('ออกแบบ, เอกสาร')
    expect(card).toContain('08:45 น.')
    expect(card).toContain(SETUP_DONE_TEXT.off)
    expect(card).toContain(SETUP_DONE_TEXT.dailyWhat)
    expect(card).not.toContain(SETUP_DONE_TEXT.weeklyWhat)
    expect(card).toContain('…') // a long description is clipped
  })

  it('names the weekday when the weekly post is on, and says when no tags are set', () => {
    const card = json(setupDoneCard({
      liffId: 'liff', groupId: 'g1', pendingOwnerName: null,
      recap: { ...RECAP, tagSet: [], features: { ...RECAP.features, weeklySummary: true } },
    }))
    expect(card).toContain('ทุกวันศ. 17:30 น.')
    expect(card).toContain(SETUP_DONE_TEXT.noTags)
    expect(card).toContain(SETUP_DONE_TEXT.weeklyWhat)
  })

  it('without a recap the card is as before', () => {
    expect(json(setupDoneCard({ liffId: 'liff', groupId: 'g1', pendingOwnerName: null }))).not.toContain(SETUP_DONE_TEXT.recapTitle)
  })

  it('the card pushed after the form carries the saved values', async () => {
    const h = makeTestDeps()
    h.line.groupMemberCounts.set('Cteam', 2)
    await handleWebhookRequest(signedRequest(webhookBody(ev.join({ groupId: 'Cteam' }))), h.deps, h.defer)
    await h.runDeferred()
    const group = h.store.tables.groups.find((g) => g.lineGroupId === 'Cteam')!
    h.line.idTokens.set('tok-me', { lineUserId: 'Ume', displayName: 'Me' })
    h.line.profiles.set('Cteam:Ume', 'Me')
    await loadSetup(h.deps, { idToken: 'tok-me', groupId: group.id })
    const res = await submitSetup(h.deps, {
      idToken: 'tok-me', groupId: group.id, workDescription: 'ทำแอป',
      features: { summarize: true, saveFiles: false, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '08:45', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
      members: [{ lineUserId: 'Ume', nicknames: ['มี่'], role: 'PM' }], ownerLineUserId: 'Ume', tagSet: ['ออกแบบ'],
    }, h.defer)
    expect(res.status).toBe(200)
    const pushed = json(h.line.pushes.at(-1)!.messages[0])
    expect(pushed).toContain(SETUP_DONE_TEXT.recapTitle)
    expect(pushed).toContain('ออกแบบ')
    expect(pushed).toContain('ทุกวันศ. 17:30 น.')
  })
})

describe('the setup card says an Owner is chosen (#143)', () => {
  it('mentions the bot Owner and their Drive', () => {
    expect(json(setupCard({ liffId: 'liff', groupId: 'g1' }))).toContain('เจ้าของบอท')
    expect(SETUP_CARD_TEXT.ask).toContain('Google Drive')
  })
})

describe('form copy (#143)', () => {
  it('the Owner note lists what the Owner does, and the choice reads as a choice', () => {
    const html = renderToStaticMarkup(OwnerRoleNote())
    for (const item of OWNER_ROLE.items) expect(html).toContain(item)
    expect(OWNER_ROLE.choose).toBe('เลือกเป็นเจ้าของบอท')
  })

  it('the tag set is named as Task tags and says what it is for', () => {
    expect(TAG_SET_COPY.label).toContain('แท็กงาน')
    expect(TAG_SET_COPY.hint).toContain('จัดประเภทงาน')
  })

  it('each time says what it posts, who sees it, and why it is off', () => {
    expect(TIMES_COPY.dailyWhat).toContain('ทุกคนในกลุ่มเห็น')
    expect(TIMES_COPY.weeklyWhat).toContain('ทุกคนในกลุ่มเห็น')
    expect(TIMES_COPY.dailyOff).toContain(FEATURES.find((f) => f.key === 'trackRemind')!.label)
    expect(TIMES_COPY.weeklyOff).toContain(FEATURES.find((f) => f.key === 'weeklySummary')!.label)
  })
})

describe('Settings Save stays off until something changes (#143)', () => {
  const form = (): SetupForm => ({
    workDescription: 'ทำแอป', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', ownerLineUserId: 'Ume',
    members: [{ lineUserId: 'Ume', displayName: 'Me', nicknames: [], role: null }], tagSet: [],
  } as unknown as SetupForm)

  it('is clean right after loading and dirty after an edit', () => {
    const f = form()
    const base = formKey(f)
    expect(isSettingsDirty(base, f)).toBe(false)
    expect(isSettingsDirty(base, { ...f, dailyReminderTime: '09:15' })).toBe(true)
    expect(isSettingsDirty(base, { ...f, tagSet: ['ออกแบบ'] })).toBe(true)
  })

  it('an edit undone is clean again, and no baseline counts as changed', () => {
    const f = form()
    const base = formKey(f)
    expect(isSettingsDirty(base, { ...f, dailyReminderTime: '09:00' })).toBe(false)
    expect(isSettingsDirty(null, f)).toBe(true)
  })
})
