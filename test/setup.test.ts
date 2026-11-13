import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { liffUrl } from '@/server/liff-links'
import { confirmOwner } from '@/server/setup/confirm'
import { loadSetup } from '@/server/setup/load'
import { submitSetup } from '@/server/setup/submit'
import type { OwnerConfirmResult, SetupLoad, SetupSubmitResult } from '@/server/setup/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, TEST_LIFF_ID, TEST_NOW, webhookBody } from './harness'

// #52 acceptance: join, load, send with self or another Owner, Owner confirm, and the
// refusals, through the webhook and the setup endpoints.

const LINE_GROUP = 'Cgroup1'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function flexJson(messages: LineMessage[]): string {
  return JSON.stringify(messages)
}

/** URIs of every button in a Flex message. */
function uris(messages: LineMessage[]): string[] {
  return [...flexJson(messages).matchAll(/"uri":"([^"]+)"/g)].map((m) => m[1])
}

async function setup() {
  const h = makeTestDeps()
  h.line.groupNames.set(LINE_GROUP, 'ทีมแอป')
  h.line.groupMemberCounts.set(LINE_GROUP, 3)
  const send = async (...events: LineEvent[]) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  // The bot joins; Pim already sent a message (a known Member); Me opens the form and is
  // added through LINE's member profile; Outsider is not in the group.
  await send(ev.join({}))
  const group = h.store.tables.groups.find((g) => g.lineGroupId === LINE_GROUP)!
  h.store.seedMember({ groupId: group.id, lineUserId: 'Upim', displayName: 'Pim Sirin' })
  h.line.profiles.set(`${LINE_GROUP}:Ume`, 'Me Myself')
  for (const [tok, id, name] of [['tok-me', 'Ume', 'Me Myself'], ['tok-pim', 'Upim', 'Pim Sirin'], ['tok-out', 'Uout', 'Outsider']]) {
    h.line.idTokens.set(tok, { lineUserId: id, displayName: name })
  }
  const load = (idToken = 'tok-me', groupId = group.id) => loadSetup(h.deps, { idToken, groupId })
  const form = (p: Record<string, unknown> = {}) => ({
    idToken: 'tok-me', groupId: group.id, workDescription: 'ทำแอปส่งอาจารย์',
    features: { summarize: true, saveFiles: false, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '08:45', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30',
    members: [
      { lineUserId: 'Ume', nicknames: ['มี่', ' '], role: 'PM' },
      { lineUserId: 'Upim', nicknames: ['พิม', 'Pim'], role: 'ออกแบบ' },
    ],
    ownerLineUserId: 'Ume',
    ...p,
  })
  const submit = async (p: Record<string, unknown> = {}) => {
    await load(String(p.idToken ?? 'tok-me')) // the page loads first; this adds Me as a Member
    return submitSetup(h.deps, form(p))
  }
  const confirm = (idToken: string) => confirmOwner(h.deps, { idToken, groupId: group.id })
  const row = () => h.store.tables.groups.find((g) => g.id === group.id)!
  const member = (id: string) => h.store.tables.group_members.find((m) => m.groupId === group.id && m.lineUserId === id)
  return { ...h, group, send, load, form, submit, confirm, row, member }
}

describe('#2a join', () => {
  it('replies with the setup card whose button opens the form for this group, and stores the group name', async () => {
    const t = await setup()
    expect(t.line.replies).toHaveLength(1)
    const { messages } = t.line.replies[0]
    expect(messages[0].type).toBe('flex')
    const json = flexJson(messages)
    for (const s of ['สวัสดี น้องจดดีมาแล้วนะ 👋', 'ใช้เวลาประมาณ 1 นาที 4 ข้อ:', 'กลุ่มนี้ทำเรื่องอะไร', 'ใครทำหน้าที่อะไร',
      'อยากให้ NongJoDII ช่วยอะไร', 'ให้เตือนตอนไหน', 'ตั้งค่ากลุ่ม', 'แตะแล้วเปิดแบบฟอร์มในแอป LINE']) {
      expect(json).toContain(s)
    }
    expect(uris(messages)).toEqual([liffUrl(TEST_LIFF_ID, 'setup', t.group.id)])
    expect(t.row().name).toBe('ทีมแอป')
    expect(t.line.pushes).toHaveLength(0)
  })

  it('a redelivered join replies once', async () => {
    const t = await setup()
    await t.send(ev.join({ eventId: 'ev-join-x' }))
    await t.send(ev.join({ eventId: 'ev-join-x', redelivery: true }))
    expect(t.line.replies).toHaveLength(2) // the setup join and this one, not three
  })

  it('a failed group name lookup still replies with the card', async () => {
    const h = makeTestDeps()
    h.line.failGroupSummary = true
    await handleWebhookRequest(signedRequest(webhookBody(ev.join({}))), h.deps, h.defer)
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expect(h.store.tables.groups[0].name).toBeNull()
  })

  it('a re-invite to a set-up group posts the card again and keeps the setup', async () => {
    const t = await setup()
    await t.submit()
    const before = { ...t.row() }
    await t.send(ev.join({}))
    expect(t.line.replies).toHaveLength(2)
    expect(t.row()).toEqual(before)
  })
})

describe('setup load', () => {
  it('lists the live Members by LINE name, the requester first, with the defaults', async () => {
    const t = await setup()
    const res = await t.load()
    expect(res.status).toBe(200)
    const body = res.body as SetupLoad
    expect(body.groupName).toBe('ทีมแอป')
    expect(body.state).toBe('open')
    expect(body.requesterLineUserId).toBe('Ume')
    expect(body.members.map((m) => [m.lineUserId, m.displayName])).toEqual([['Ume', 'Me Myself'], ['Upim', 'Pim Sirin']])
    expect(body.values).toEqual({
      workDescription: '', features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00', ownerLineUserId: null,
    })
    expect(body.nominee).toBeNull()
  })

  it('refuses a bad token (401), a bad or unknown group (400, 404) and a non-Member (403)', async () => {
    const t = await setup()
    expect((await t.load('tok-bogus')).status).toBe(401)
    expect((await loadSetup(t.deps, { groupId: t.group.id })).status).toBe(401)
    expect((await t.load('tok-me', 'Cgroup1')).status).toBe(400)
    expect((await t.load('tok-me', '00000000-0000-4000-8000-000000000000')).status).toBe(404)
    expect((await t.load('tok-out')).status).toBe(403)
  })
})

describe('setup send, self as Owner', () => {
  it('saves everything, confirms the sender and makes the group the main group of a new Project', async () => {
    const t = await setup()
    const res = await t.submit()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'confirmed', posted: 'pushed' } satisfies SetupSubmitResult)

    const g = t.row()
    expect(g.workDescription).toBe('ทำแอปส่งอาจารย์')
    expect(g.featureSummarize).toBe(true)
    expect(g.featureDraftTasks).toBe(true)
    expect(g.featureTrackRemind).toBe(true)
    expect(g.nominatedOwnerLineUserId).toBe('Ume')
    expect(g.ownerConfirmedAt).toEqual(TEST_NOW)
    expect(t.store.tables.projects).toEqual([{ id: g.projectId, ownerLineUserId: 'Ume' }])
    expect(t.store.tables.group_setups[0]).toMatchObject({ isMain: true, featureSaveFiles: false, ownerNominatedByLineUserId: 'Ume' })
    expect(t.store.tables.group_schedules[0]).toMatchObject({
      featureWeeklySummary: true, dailyReminderTime: '08:45:00', weeklySummaryWeekday: 5, weeklySummaryTime: '17:30:00',
    })
    expect(t.member('Ume')).toMatchObject({ nicknames: ['มี่'], role: 'PM', source: 'liff' })
    expect(t.member('Upim')).toMatchObject({ nicknames: ['พิม', 'Pim'], role: 'ออกแบบ' })
    // The tick now serves the group at its chosen time.
    expect(await t.store.listDailyReminderGroups()).toEqual([
      { groupId: t.group.id, lineGroupId: LINE_GROUP, time: '08:45:00', lastSentOn: null },
    ])

    // #2e, pushed within the budget, with no Owner confirm button.
    expect(t.line.delivered).toHaveLength(1)
    const json = flexJson(t.line.delivered[0].messages)
    for (const s of ['ตั้งค่าเสร็จแล้ว ✓', 'NongJoDII รู้จักกลุ่มและทีมแล้ว', 'จากนี้น้องจดดีจะอ่านแชตและร่างงานให้กดยืนยันนะ', 'เปลี่ยนการตั้งค่าได้ทุกเมื่อ']) {
      expect(json).toContain(s)
    }
    expect(json).not.toContain('ยืนยันเจ้าของบอท')
    expect(t.store.tables.push_log.map((p) => p.purpose)).toEqual(['setup_done'])

    expect(((await t.load()).body as SetupLoad).state).toBe('confirmed')
  })

  it('refuses a second send once the Owner is confirmed (409) and changes nothing', async () => {
    const t = await setup()
    await t.submit()
    const before = { ...t.row() }
    const res = await t.submit({ workDescription: 'อย่างอื่น', ownerLineUserId: 'Upim' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'setup_closed' })
    expect(t.row()).toEqual(before)
    expect(t.store.tables.projects).toHaveLength(1)
    expect(t.line.pushes).toHaveLength(1)
  })
})

describe('setup send, another Owner', () => {
  it('leaves the Owner pending and pushes #2e with the nominee and the confirm button', async () => {
    const t = await setup()
    const res = await t.submit({ ownerLineUserId: 'Upim' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    const g = t.row()
    expect(g.nominatedOwnerLineUserId).toBe('Upim')
    expect(g.ownerConfirmedAt).toBeNull()
    expect(g.projectId).toBeNull()
    expect(t.store.tables.projects).toHaveLength(0)
    expect(t.store.tables.group_setups[0]).toMatchObject({ ownerNominatedByLineUserId: 'Ume', ownerNominatedAt: TEST_NOW })

    const { messages } = t.line.delivered[0]
    expect(flexJson(messages)).toContain('รอ Pim Sirin ยืนยันเป็นเจ้าของบอท')
    expect(flexJson(messages)).toContain('ยืนยันเจ้าของบอท')
    expect(uris(messages)).toEqual([liffUrl(TEST_LIFF_ID, 'owner', t.group.id)])

    const loaded = (await t.load('tok-pim')).body as SetupLoad
    expect(loaded.state).toBe('pending_owner')
    expect(loaded.nominee).toEqual({ lineUserId: 'Upim', displayName: 'Pim Sirin' })
  })

  it('the nominee confirms: the Project is created with them as owner; a repeat is a no-op', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    const res = await t.confirm('tok-pim')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'confirmed', alreadyConfirmed: false } satisfies OwnerConfirmResult)
    const g = t.row()
    expect(g.ownerConfirmedAt).toEqual(TEST_NOW)
    expect(t.store.tables.projects).toEqual([{ id: g.projectId, ownerLineUserId: 'Upim' }])
    expect(t.store.tables.group_setups[0].isMain).toBe(true)
    // No extra push on confirm.
    expect(t.line.pushes).toHaveLength(1)

    const again = await t.confirm('tok-pim')
    expect(again.body).toEqual({ state: 'confirmed', alreadyConfirmed: true })
    expect(t.store.tables.projects).toHaveLength(1)
  })

  it('refuses a confirm from anyone but the nominee', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    const res = await t.confirm('tok-me')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'not_nominee' })
    expect((await t.confirm('tok-out')).status).toBe(403)
    expect((await t.confirm('tok-bogus')).status).toBe(401)
    expect(t.row().ownerConfirmedAt).toBeNull()
    expect(t.store.tables.projects).toHaveLength(0)
  })

  it('a resent form may name someone else while the Owner is still pending', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    const res = await t.submit({ ownerLineUserId: 'Ume' })
    expect(res.body).toMatchObject({ state: 'confirmed' })
    expect((await t.confirm('tok-pim')).status).toBe(403)
    expect(t.store.tables.projects).toEqual([{ id: t.row().projectId, ownerLineUserId: 'Ume' }])
  })

  it('a push skipped for quota still saves the setup', async () => {
    const t = await setup()
    t.line.quota = { limit: 300, used: 299 }
    const res = await t.submit({ ownerLineUserId: 'Upim' })
    expect(res.body).toEqual({ state: 'pending_owner', posted: 'skipped_quota' })
    expect(t.line.pushes).toHaveLength(0)
    expect(t.row().nominatedOwnerLineUserId).toBe('Upim')
  })
})

describe('setup send refusals', () => {
  it('a non-Member cannot send the form (403) and nothing is saved', async () => {
    const t = await setup()
    const res = await submitSetup(t.deps, t.form({ idToken: 'tok-out' }))
    expect(res.status).toBe(403)
    expect(t.row().nominatedOwnerLineUserId).toBeNull()
    expect(t.row().workDescription).toBeNull()
    expect(t.line.pushes).toHaveLength(0)
  })

  it('a bad token cannot send (401)', async () => {
    const t = await setup()
    expect((await submitSetup(t.deps, t.form({ idToken: 'tok-bogus' }))).status).toBe(401)
  })

  it('invalid input is refused with the field name (400) and nothing is saved', async () => {
    const t = await setup()
    const cases: [Record<string, unknown>, string][] = [
      [{ workDescription: 'ก'.repeat(2001) }, 'workDescription'],
      [{ workDescription: 7 }, 'workDescription'],
      [{ features: { summarize: true } }, 'features'],
      [{ dailyReminderTime: '09:10' }, 'dailyReminderTime'],
      [{ weeklySummaryWeekday: 0 }, 'weeklySummaryWeekday'],
      [{ weeklySummaryWeekday: 8 }, 'weeklySummaryWeekday'],
      [{ weeklySummaryTime: '25:00' }, 'weeklySummaryTime'],
      [{ members: [{ lineUserId: 'Ume', nicknames: ['x'.repeat(51)], role: '' }] }, 'members'],
      [{ members: [{ lineUserId: 'Ume', nicknames: [], role: 'x'.repeat(101) }] }, 'members'],
      [{ members: [{ lineUserId: 'Ume', nicknames: [], role: '' }, { lineUserId: 'Ume', nicknames: [], role: '' }] }, 'members'],
      [{ members: [{ lineUserId: 'Uout', nicknames: [], role: '' }] }, 'members'],
      [{ ownerLineUserId: 'Uout' }, 'ownerLineUserId'],
      [{ ownerLineUserId: null }, 'ownerLineUserId'],
    ]
    for (const [patch, f] of cases) {
      const res = await t.submit(patch)
      expect(res, f).toMatchObject({ status: 400, body: { error: 'bad_request', field: f } })
    }
    expect(t.row().nominatedOwnerLineUserId).toBeNull()
    expect(t.line.pushes).toHaveLength(0)
  })

  it('an Owner who left the group cannot be named', async () => {
    const t = await setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Uleft', displayName: 'Left', leftAt: TEST_NOW })
    const res = await t.submit({ ownerLineUserId: 'Uleft' })
    expect(res).toMatchObject({ status: 400, body: { field: 'ownerLineUserId' } })
  })
})
