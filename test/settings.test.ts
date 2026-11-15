import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent } from '@/server/line/types'
import { liffUrl } from '@/server/liff-links'
import { SETTINGS_CARD_TEXT } from '@/server/settings/card'
import { loadSettings, submitSettings } from '@/server/settings/settings'
import type { SettingsLoad } from '@/server/settings/types'
import { handleTickRequest } from '@/server/tick/handle-request'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { TEST_LIFF_ID, ev, makeTestDeps, seedOwnedGroup, signedRequest, tickRequest, webhookBody } from './harness'

// #28 Settings through the LIFF endpoints, the tick seam (a changed reminder time) and the
// webhook seam (the "NongJoDII ตั้งค่า" command).

const OWNER = 'Uowner1'
const BIW = 'Ubiw'
const bkk = (s: string) => new Date(`${s}+07:00`)

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  const group = seedOwnedGroup(h.store, {
    members: [
      { lineUserId: OWNER, displayName: 'โอ๋', nicknames: ['โอ๋'], role: 'หัวหน้า' },
      { lineUserId: BIW, displayName: 'บิว', nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' },
    ],
  })
  h.store.seedSchedule(group.id, { featureWeeklySummary: false })
  h.line.groupMemberCounts.set('Cgroup1', 5)
  h.line.idTokens.set('tok-owner', { lineUserId: OWNER, displayName: 'โอ๋' })
  h.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const tickAt = async (at: Date) => {
    h.setNow(at)
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const body = (p: Record<string, unknown> = {}) => ({
    idToken: 'tok-owner', groupId: group.id, workDescription: 'ทำโปรเจกต์จบ',
    features: { summarize: true, saveFiles: false, trackRemind: true, weeklySummary: false },
    dailyReminderTime: '10:00', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
    members: [{ lineUserId: BIW, nicknames: ['บิวบิว'], role: 'ทำสไลด์' }],
    ...p,
  })
  const row = (id: string) => h.store.tables.group_members.find((m) => m.groupId === group.id && m.lineUserId === id)!
  return { ...h, group, send, tickAt, body, row }
}

describe('loadSettings (#28)', () => {
  it('the confirmed Owner gets the values and every Member\'s nicknames and role to edit', async () => {
    const t = setup()
    const res = await loadSettings(t.deps, { idToken: 'tok-owner', groupId: t.group.id })
    expect(res.status).toBe(200)
    const view = res.body as SettingsLoad
    expect(view).toMatchObject({ state: 'ready', canEdit: true, owner: { lineUserId: OWNER, displayName: 'โอ๋' } })
    expect(view.values).toMatchObject({ dailyReminderTime: '09:00', weeklySummaryWeekday: 1 })
    expect(view.members.find((m) => m.lineUserId === BIW)).toEqual({ lineUserId: BIW, displayName: 'บิว', nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' })
  })

  it('a Member may look but not edit, and sees LINE names without nicknames or roles', async () => {
    const t = setup()
    const view = (await loadSettings(t.deps, { idToken: 'tok-biw', groupId: t.group.id })).body as SettingsLoad
    expect(view.canEdit).toBe(false)
    expect(view.members.map((m) => [m.displayName, m.nicknames, m.role])).toEqual([['บิว', [], null], ['โอ๋', [], null]])
  })

  it('a group without a confirmed Owner is not set up yet', async () => {
    const t = setup()
    t.store.tables.groups.find((g) => g.id === t.group.id)!.ownerConfirmedAt = null
    const view = (await loadSettings(t.deps, { idToken: 'tok-owner', groupId: t.group.id })).body as SettingsLoad
    expect(view).toMatchObject({ state: 'not_set_up', canEdit: false, owner: null })
  })
})

describe('submitSettings (#28)', () => {
  it('the Owner saves every setup value, and nicknames and roles', async () => {
    const t = setup()
    expect(await submitSettings(t.deps, t.body())).toEqual({ status: 200, body: { saved: true } })
    const view = (await loadSettings(t.deps, { idToken: 'tok-owner', groupId: t.group.id })).body as SettingsLoad
    expect(view.values).toEqual({
      workDescription: 'ทำโปรเจกต์จบ',
      features: { summarize: true, saveFiles: false, trackRemind: true, weeklySummary: false },
      dailyReminderTime: '10:00', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
    })
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิวบิว'], role: 'ทำสไลด์' })
    // Screens still show LINE names.
    expect(view.members.find((m) => m.lineUserId === BIW)?.displayName).toBe('บิว')
  })

  it('a changed reminder time moves when the group next gets its daily reminder', async () => {
    const t = setup()
    t.store.seedTask({ groupId: t.group.id, createdByLineUserId: OWNER, title: 'ส่งรายงาน', status: 'in_process', assigneeLineUserId: BIW, dueAt: bkk('2026-11-16T17:00:00') })
    await submitSettings(t.deps, t.body({ dailyReminderTime: '10:00' }))
    await t.tickAt(bkk('2026-11-16T09:00:00'))
    expect(t.line.pushes).toHaveLength(0)
    await t.tickAt(bkk('2026-11-16T10:00:00'))
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a Member is refused and nothing changes', async () => {
    const t = setup()
    const res = await submitSettings(t.deps, t.body({ idToken: 'tok-biw' }))
    expect(res).toEqual({ status: 403, body: { error: 'not_owner' } })
    const view = (await loadSettings(t.deps, { idToken: 'tok-owner', groupId: t.group.id })).body as SettingsLoad
    expect(view.values.dailyReminderTime).toBe('09:00')
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' })
  })

  it('an Owner change between the check and the write saves nothing', async () => {
    const t = setup()
    const realSave = t.store.saveGroupSettings.bind(t.store)
    vi.spyOn(t.store, 'saveGroupSettings').mockImplementationOnce(async (w) => {
      t.store.tables.groups.find((g) => g.id === t.group.id)!.nominatedOwnerLineUserId = BIW
      return realSave(w)
    })
    expect((await submitSettings(t.deps, t.body())).status).toBe(403)
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว', 'Bew'] })
  })

  it('writes only the Members whose nicknames or role changed', async () => {
    const t = setup()
    await submitSettings(t.deps, t.body({
      members: [
        { lineUserId: OWNER, nicknames: ['โอ๋'], role: 'หัวหน้า' }, // as stored
        { lineUserId: BIW, nicknames: ['บิว', 'Bew'], role: 'ทำสไลด์' }, // role changed
      ],
    }))
    expect(t.store.settingsMemberWrites).toBe(1)
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว', 'Bew'], role: 'ทำสไลด์' })
    expect(t.row(OWNER)).toMatchObject({ nicknames: ['โอ๋'], role: 'หัวหน้า' })
  })

  it('a save of the times alone writes no Member', async () => {
    const t = setup()
    await submitSettings(t.deps, t.body({
      members: [{ lineUserId: OWNER, nicknames: ['โอ๋'], role: 'หัวหน้า' }, { lineUserId: BIW, nicknames: ['บิว', 'Bew'], role: 'ออกแบบ' }],
    }))
    expect(t.store.settingsMemberWrites).toBe(0)
  })

  it('a nickname split differently still counts as a change', async () => {
    const t = setup()
    await submitSettings(t.deps, t.body({ members: [{ lineUserId: BIW, nicknames: ['บิว\nBew'], role: 'ออกแบบ' }] }))
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว\nBew'] })
  })

  it('a listed person who left is skipped and the rest saves', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    const res = await submitSettings(t.deps, t.body({ members: [{ lineUserId: BIW, nicknames: ['x'], role: 'y' }, { lineUserId: OWNER, nicknames: ['พี่โอ๋'], role: '' }] }))
    expect(res.status).toBe(200)
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว', 'Bew'] })
    expect(t.row(OWNER)).toMatchObject({ nicknames: ['พี่โอ๋'], role: null })
  })

  it('refuses bad values with the field', async () => {
    const t = setup()
    expect(await submitSettings(t.deps, t.body({ dailyReminderTime: '09:10' }))).toEqual({ status: 400, body: { error: 'bad_request', field: 'dailyReminderTime' } })
    expect((await submitSettings(t.deps, t.body({ weeklySummaryWeekday: 8 }))).status).toBe(400)
    expect((await submitSettings(t.deps, t.body({ features: { summarize: true } }))).status).toBe(400)
    expect((await submitSettings(t.deps, t.body({ idToken: 'nope' }))).status).toBe(401)
  })
})

describe('"NongJoDII ตั้งค่า" (#28)', () => {
  it('answers with one reply carrying the Settings link, and no push', async () => {
    const t = setup()
    await t.send(ev.groupText({ text: 'NongJoDII ตั้งค่า', userId: BIW }))
    expect(t.line.replies).toHaveLength(1)
    const body = JSON.stringify(t.line.replies[0].messages)
    expect(body).toContain(SETTINGS_CARD_TEXT.title)
    expect(body).toContain(JSON.stringify(liffUrl(TEST_LIFF_ID, 'settings', t.group.id)))
    expect(t.line.pushes).toHaveLength(0)
    expect(t.llm.requests).toHaveLength(0)
  })
})
