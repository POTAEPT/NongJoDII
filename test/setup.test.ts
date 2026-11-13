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
const MIN = 60_000

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

type Setup = Awaited<ReturnType<typeof setup>>

/** The messages of the newest reply. */
function lastReply(t: Pick<Setup, 'line'>): LineMessage[] {
  return t.line.replies[t.line.replies.length - 1].messages
}

// The two helpers below run `between` after the endpoint's own checks and right before the
// store's write: a concurrent request or a leave that only the row lock in setup_group or
// confirm_group_owner can catch. The tests assert the answer and the stored rows.
function beforeSave(t: Setup, between: () => Promise<unknown> | void): void {
  const real = t.store.saveGroupSetup.bind(t.store)
  t.store.saveGroupSetup = async (w) => {
    await between()
    return real(w)
  }
}

function beforeConfirm(t: Setup, between: () => Promise<unknown> | void): void {
  const real = t.store.confirmGroupOwner.bind(t.store)
  t.store.confirmGroupOwner = async (groupId, lineUserId, at) => {
    await between()
    return real(groupId, lineUserId, at)
  }
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

  it('a failed join reply still stores the group name', async () => {
    const h = makeTestDeps()
    h.line.failReply = true
    h.line.groupNames.set(LINE_GROUP, 'ทีมแอป')
    await handleWebhookRequest(signedRequest(webhookBody(ev.join({}))), h.deps, h.defer)
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1) // attempted once, rejected by LINE
    expect(h.store.tables.groups[0].name).toBe('ทีมแอป')
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

    // Closed: the load no longer hands out nicknames or roles.
    const closedLoad = (await t.load()).body as SetupLoad
    expect(closedLoad.state).toBe('confirmed')
    expect(closedLoad.members.every((m) => m.nicknames.length === 0 && m.role === null)).toBe(true)
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
    // Still editable: the saved nicknames come back so a resent form keeps them.
    expect(loaded.members.find((m) => m.lineUserId === 'Upim')).toMatchObject({ nicknames: ['พิม', 'Pim'], role: 'ออกแบบ' })
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

  it('a resend after a failed card delivers it, under the failed attempt\'s retry key', async () => {
    const t = await setup()
    t.line.failPush = true
    expect((await t.submit({ ownerLineUserId: 'Upim' })).body).toEqual({ state: 'pending_owner', posted: 'failed' })
    t.line.failPush = false
    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    const res = await t.submit({ ownerLineUserId: 'Upim' })
    expect(res.body).toEqual({ state: 'pending_owner', posted: 'pushed' } satisfies SetupSubmitResult)
    expect(t.line.pushes).toHaveLength(2)
    expect(t.line.pushes[1].retryKey).toBe(t.line.pushes[0].retryKey)
    // The Owner confirm link reaches the group after all.
    expect(t.line.delivered).toHaveLength(1)
    expect(flexJson(t.line.delivered[0].messages)).toContain('รอ Pim Sirin ยืนยันเป็นเจ้าของบอท')
    expect(uris(t.line.delivered[0].messages)).toEqual([liffUrl(TEST_LIFF_ID, 'owner', t.group.id)])
  })

  it('a resend after a card skipped for quota delivers it once the quota allows', async () => {
    const t = await setup()
    t.line.quota = { limit: 300, used: 299 }
    expect((await t.submit({ ownerLineUserId: 'Upim' })).body).toEqual({ state: 'pending_owner', posted: 'skipped_quota' })
    expect(t.line.pushes).toHaveLength(0)
    t.line.quota = { limit: 300, used: 0 }
    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    expect((await t.submit({ ownerLineUserId: 'Upim' })).body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    expect(t.line.delivered).toHaveLength(1)
    expect(flexJson(t.line.delivered[0].messages)).toContain('รอ Pim Sirin ยืนยันเป็นเจ้าของบอท')
  })

  it('a resend after a delivered card repeats its retry key, so LINE does not post it twice', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    const firstClaim = t.store.tables.push_log.map((r) => r.id)
    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    const res = await t.submit({ ownerLineUserId: 'Upim', workDescription: 'แก้คำอธิบาย' })
    expect(res.body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    expect(t.row().workDescription).toBe('แก้คำอธิบาย')
    expect(t.line.pushes).toHaveLength(2)
    expect(t.line.pushes[1].retryKey).toBe(t.line.pushes[0].retryKey)
    // FakeLine answers a repeated key as LINE does (409: duplicate, nothing sent) ...
    expect(t.line.delivered).toHaveLength(1)
    // ... so the resend's budget claim is given back: only the first card's claim stays.
    expect(t.store.tables.push_log.map((r) => r.id)).toEqual(firstClaim)
  })

  it('a nomination back to an earlier nominee posts a card naming them again, under a new key', async () => {
    const t = await setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Ucarol', displayName: 'Carol K.' })
    for (const [i, owner] of ['Upim', 'Ucarol', 'Upim'].entries()) {
      t.setNow(new Date(TEST_NOW.getTime() + i * MIN))
      expect((await t.submit({ ownerLineUserId: owner })).body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    }
    expect(new Set(t.line.pushes.map((p) => p.retryKey)).size).toBe(3)
    // LINE delivered all three: the newest card in the group names Pim again.
    expect(t.line.delivered).toHaveLength(3)
    expect(flexJson(t.line.delivered[1].messages)).toContain('รอ Carol K. ยืนยันเป็นเจ้าของบอท')
    expect(flexJson(t.line.delivered[2].messages)).toContain('รอ Pim Sirin ยืนยันเป็นเจ้าของบอท')
  })

  it('a send whose loaded row is stale keys its card on the stored nomination time', async () => {
    const t = await setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Ucarol', displayName: 'Carol K.' })
    await t.submit({ ownerLineUserId: 'Upim' }) // Me names Pim at TEST_NOW: card 1
    // Me resends Pim from a page loaded while Pim was the nominee. Between that load and the
    // write, another send names Carol, so this write names Pim anew, at this send's time.
    const save = t.store.saveGroupSetup.bind(t.store)
    beforeSave(t, () => save({
      groupId: t.group.id, byLineUserId: 'Upim', workDescription: null,
      features: { summarize: true, draftTasks: true, saveFiles: true, trackRemind: true, weeklySummary: true },
      dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
      members: [], ownerLineUserId: 'Ucarol', at: new Date(TEST_NOW.getTime() + MIN),
    }))
    const second = new Date(TEST_NOW.getTime() + 2 * MIN)
    t.setNow(second)
    expect((await t.submit({ ownerLineUserId: 'Upim' })).body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    expect((await t.store.getGroupSetup(t.group.id))?.ownerNominatedAt).toEqual(second)
    // Not the loaded row's time (card 1's key): LINE delivers the card naming Pim again.
    expect(t.line.pushes[1].retryKey).not.toBe(t.line.pushes[0].retryKey)
    expect(t.line.delivered).toHaveLength(2)
    expect(flexJson(t.line.delivered[1].messages)).toContain('รอ Pim Sirin ยืนยันเป็นเจ้าของบอท')

    // A plain resend now repeats card 2's key: that key came from the stored time.
    t.store.saveGroupSetup = save
    t.setNow(new Date(TEST_NOW.getTime() + 3 * MIN))
    await t.submit({ ownerLineUserId: 'Upim' })
    expect(t.line.pushes[2].retryKey).toBe(t.line.pushes[1].retryKey)
    expect(t.line.delivered).toHaveLength(2)
  })

  it('a failed read after the write keys the card on this send\'s time: a repeat, never a loss', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    const save = t.store.saveGroupSetup.bind(t.store)
    t.store.saveGroupSetup = async (w) => {
      const saved = await save(w)
      t.store.failNext('getGroupSetup') // the read after this write
      return saved
    }
    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    expect((await t.submit({ ownerLineUserId: 'Upim' })).body).toEqual({ state: 'pending_owner', posted: 'pushed' })
    expect(t.line.pushes[1].retryKey).not.toBe(t.line.pushes[0].retryKey)
    expect(t.line.delivered).toHaveLength(2)
  })

  it('a resend keeps who nominated and when; a new nominee sets both', async () => {
    const t = await setup()
    t.store.seedMember({ groupId: t.group.id, lineUserId: 'Ucarol', displayName: 'Carol K.' })
    t.line.idTokens.set('tok-carol', { lineUserId: 'Ucarol', displayName: 'Carol K.' })
    const nomination = async () => {
      const g = await t.store.getGroupSetup(t.group.id)
      const x = t.store.tables.group_setups.find((r) => r.groupId === t.group.id)
      return { at: g?.ownerNominatedAt, by: x?.ownerNominatedByLineUserId }
    }
    await t.submit({ ownerLineUserId: 'Upim' }) // Me names Pim
    expect(await nomination()).toEqual({ at: TEST_NOW, by: 'Ume' })

    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    await t.submit({ idToken: 'tok-carol', ownerLineUserId: 'Upim' }) // Carol resends, same nominee
    expect(await nomination()).toEqual({ at: TEST_NOW, by: 'Ume' })

    const later = new Date(TEST_NOW.getTime() + 2 * MIN)
    t.setNow(later)
    await t.submit({ idToken: 'tok-carol', ownerLineUserId: 'Ume' }) // Carol names Me
    expect(await nomination()).toEqual({ at: later, by: 'Ucarol' })
  })

  it('the pending nominee sending the form for themselves is confirmed and gets the confirmed card', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' }) // Me names Pim; the pending card is delivered
    t.setNow(new Date(TEST_NOW.getTime() + MIN))
    const res = await t.submit({ idToken: 'tok-pim', ownerLineUserId: 'Upim' })
    expect(res.body).toEqual({ state: 'confirmed', posted: 'pushed' })
    // Same nominee and nomination time as the pending card, but a new outcome: a new key.
    expect(t.line.pushes[1].retryKey).not.toBe(t.line.pushes[0].retryKey)
    expect(t.line.delivered).toHaveLength(2)
    expect(flexJson(t.line.delivered[1].messages)).not.toContain('ยืนยันเจ้าของบอท')
    expect(t.store.tables.projects).toEqual([{ id: t.row().projectId, ownerLineUserId: 'Upim' }])
  })

  it('a failed push still saves the setup and gives the budget back', async () => {
    const t = await setup()
    t.line.failPush = true
    const res = await t.submit({ ownerLineUserId: 'Upim' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ state: 'pending_owner', posted: 'failed' })
    expect(t.row().nominatedOwnerLineUserId).toBe('Upim')
    expect(t.store.tables.push_log).toHaveLength(0)
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
      [{ members: [{ lineUserId: 'Ume', nicknames: 'มี่', role: '' }] }, 'members'],
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

describe('a listed person who is no longer a Member', () => {
  it('is dropped and the rest of the form is saved', async () => {
    const t = await setup()
    await t.load() // the page loaded while Pim was still here
    t.member('Upim')!.leftAt = TEST_NOW
    const res = await submitSetup(t.deps, t.form({
      members: [
        { lineUserId: 'Ume', nicknames: ['มี่'], role: 'PM' },
        { lineUserId: 'Upim', nicknames: ['พิม'], role: 'ออกแบบ' },
        { lineUserId: 'Uout', nicknames: ['เอาท์'], role: 'แขก' },
      ],
    }))
    expect(res.body).toEqual({ state: 'confirmed', posted: 'pushed' })
    expect(t.member('Ume')).toMatchObject({ nicknames: ['มี่'], role: 'PM' })
    expect(t.member('Upim')).toMatchObject({ nicknames: [], role: null, leftAt: TEST_NOW })
    expect(t.member('Uout')).toBeUndefined()
  })
})

describe('rechecks under the row lock', () => {
  it('the named Owner leaves between the checks and the write: 400 and nothing is saved', async () => {
    const t = await setup()
    beforeSave(t, () => {
      t.member('Upim')!.leftAt = TEST_NOW
    })
    const res = await t.submit({ ownerLineUserId: 'Upim' })
    expect(res).toMatchObject({ status: 400, body: { error: 'bad_request', field: 'ownerLineUserId' } })
    expect(t.row()).toMatchObject({ nominatedOwnerLineUserId: null, workDescription: null })
    expect(t.line.pushes).toHaveLength(0)
  })

  it('the nominee confirms between the checks and the write: the send is refused (409)', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    beforeSave(t, () => t.store.confirmGroupOwner(t.group.id, 'Upim', TEST_NOW))
    const res = await t.submit({ ownerLineUserId: 'Ume', workDescription: 'อย่างอื่น' })
    expect(res).toMatchObject({ status: 409, body: { error: 'setup_closed' } })
    expect(t.row()).toMatchObject({ nominatedOwnerLineUserId: 'Upim', ownerConfirmedAt: TEST_NOW, workDescription: 'ทำแอปส่งอาจารย์' })
    expect(t.store.tables.projects).toEqual([{ id: t.row().projectId, ownerLineUserId: 'Upim' }])
    expect(t.line.pushes).toHaveLength(1)
  })

  it('the nominee leaves between the checks and the confirm: 403 and no Project', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    beforeConfirm(t, () => {
      t.member('Upim')!.leftAt = TEST_NOW
    })
    const res = await t.confirm('tok-pim')
    expect(res).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(t.row().ownerConfirmedAt).toBeNull()
    expect(t.store.tables.projects).toHaveLength(0)
  })
})

describe('a group with a Project but no confirmed Owner (in_project)', () => {
  /** The confirmed Owner (Me) left, and the group named Pim, who has not confirmed: an
   *  Owner change of the Project, which goes through change_project_owner, not setup. */
  async function ownerLeft(): Promise<Setup> {
    const t = await setup()
    await t.submit()
    t.member('Ume')!.leftAt = TEST_NOW
    Object.assign(t.row(), { ownerConfirmedAt: null, nominatedOwnerLineUserId: 'Upim' })
    return t
  }

  it('load says in_project and hands out no nicknames or roles', async () => {
    const t = await ownerLeft()
    const body = (await t.load('tok-pim')).body as SetupLoad
    expect(body.state).toBe('in_project')
    expect(body.members).toEqual([{ lineUserId: 'Upim', displayName: 'Pim Sirin', nicknames: [], role: null }])
  })

  it('send and confirm are refused (409) and the Project keeps its owner', async () => {
    const t = await ownerLeft()
    const before = { ...t.row() }
    expect(await t.submit({ idToken: 'tok-pim', ownerLineUserId: 'Upim', members: [] }))
      .toMatchObject({ status: 409, body: { error: 'setup_closed' } })
    expect(await t.confirm('tok-pim')).toMatchObject({ status: 409, body: { error: 'setup_closed' } })
    expect(t.row()).toEqual(before)
    expect(t.store.tables.projects).toEqual([{ id: before.projectId, ownerLineUserId: 'Ume' }])
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a summarize request gets the no-Owner text only, without the setup card', async () => {
    const t = await ownerLeft()
    await t.send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim' }))
    expect(lastReply(t)).toHaveLength(1)
    expect(lastReply(t)[0].type).toBe('text')
    expect(t.llm.requests).toHaveLength(0)
  })
})

describe('second way to the setup card: the no-Owner Summary reply', () => {
  function expectSetupCard(messages: LineMessage[], groupId: string): void {
    expect(messages).toHaveLength(2)
    const [text, card] = messages
    expect(text.type === 'text' && text.text).toContain('กรุณาตั้งค่ากลุ่มให้เสร็จก่อน')
    expect(card.type).toBe('flex')
    expect(flexJson([card])).toContain('สวัสดี น้องจดดีมาแล้วนะ 👋')
    expect(uris([card])).toEqual([liffUrl(TEST_LIFF_ID, 'setup', groupId)])
  }

  it('a group that is not set up gets the setup card with the reply', async () => {
    const t = await setup()
    await t.send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim' }))
    expectSetupCard(lastReply(t), t.group.id)
    expect(t.llm.requests).toHaveLength(0)
    expect(t.line.pushes).toHaveLength(0)
  })

  it('so does a group whose Owner is still pending', async () => {
    const t = await setup()
    await t.submit({ ownerLineUserId: 'Upim' })
    await t.send(ev.groupText({ text: 'NongJoDII สรุปหน่อย', userId: 'Upim' }))
    expectSetupCard(lastReply(t), t.group.id)
  })

  it('so does a group the bot joined before onboarding existed (no join event)', async () => {
    const h = makeTestDeps()
    const group = h.store.seedGroup({ lineGroupId: 'Cold' })
    await handleWebhookRequest(
      signedRequest(webhookBody(ev.groupText({ text: 'NongJoDII summarize', groupId: 'Cold', userId: 'Upim' }))),
      h.deps, h.defer,
    )
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expectSetupCard(h.line.replies[0].messages, group.id)
  })
})
