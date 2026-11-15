import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LineEvent } from '@/server/line/types'
import { liffUrl } from '@/server/liff-links'
import { loadMyProfile, saveMyProfile } from '@/server/members/profile'
import { WELCOME_TEXT } from '@/server/members/welcome'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { TEST_LIFF_ID, ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #29 (join part): the welcome reply to a memberJoined event, and the "my info" screen
// where a Member sets their own nicknames and role.

const BIW = 'Ubiw'
const TON = 'Uton'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, {
    members: [
      { lineUserId: BIW, displayName: 'บิว', nicknames: ['บิว'], role: 'ออกแบบ' },
      { lineUserId: TON, displayName: 'ต้น', nicknames: ['ต้น'], role: 'บัญชี' },
    ],
  })
  h.line.idTokens.set('tok-biw', { lineUserId: BIW, displayName: 'บิว' })
  h.line.idTokens.set('tok-new', { lineUserId: 'Unew', displayName: 'มายด์' })
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  const row = (id: string) => h.store.tables.group_members.find((m) => m.groupId === group.id && m.lineUserId === id)!
  return { ...h, group, send, row }
}

describe('welcome reply to a join (#29)', () => {
  it('answers a join with one welcome reply whose button opens my info, and no push', async () => {
    const t = setup()
    await t.send(ev.memberJoined({ userIds: ['Unew'] }))
    expect(t.line.replies).toHaveLength(1)
    const body = JSON.stringify(t.line.replies[0].messages)
    expect(body).toContain(WELCOME_TEXT.title)
    expect(body).toContain(JSON.stringify(liffUrl(TEST_LIFF_ID, 'me', t.group.id)))
    expect(t.line.pushes).toHaveLength(0)
  })

  it('answers several people joining at once with one reply', async () => {
    const t = setup()
    await t.send(ev.memberJoined({ userIds: ['Unew1', 'Unew2'] }))
    expect(t.line.replies).toHaveLength(1)
  })

  it('a redelivered join is not welcomed again', async () => {
    const t = setup()
    await t.send(ev.memberJoined({ userIds: ['Unew'], eventId: 'ev-join' }))
    await t.send(ev.memberJoined({ userIds: ['Unew'], eventId: 'ev-join' }))
    expect(t.line.replies).toHaveLength(1)
  })

  it('a failed reply still stores the new name', async () => {
    const t = setup()
    t.line.failReply = true
    t.line.profiles.set('Cgroup1:Unew', 'มายด์')
    await t.send(ev.memberJoined({ userIds: ['Unew'] }))
    expect(t.store.tables.line_users.find((u) => u.lineUserId === 'Unew')?.displayName).toBe('มายด์')
  })
})

describe('my info (#29)', () => {
  it('loads only the requester’s own nicknames and role', async () => {
    const t = setup()
    const res = await loadMyProfile(t.deps, { idToken: 'tok-biw', groupId: t.group.id })
    expect(res).toEqual({
      status: 200,
      body: { groupId: t.group.id, groupName: null, displayName: 'บิว', nicknames: ['บิว'], role: 'ออกแบบ' },
    })
  })

  it('a person who just joined saves their nicknames and role, cleaned', async () => {
    const t = setup()
    await t.send(ev.memberJoined({ userIds: ['Unew'] }))
    const res = await saveMyProfile(t.deps, {
      idToken: 'tok-new', groupId: t.group.id, nicknames: [' มายด์ ', 'มายด์', '', 'Mind'], role: '  ถ่ายรูป ',
    })
    expect(res).toEqual({ status: 200, body: { nicknames: ['มายด์', 'Mind'], role: 'ถ่ายรูป' } })
    expect(t.row('Unew')).toMatchObject({ nicknames: ['มายด์', 'Mind'], role: 'ถ่ายรูป' })
  })

  it('an empty role is stored as none', async () => {
    const t = setup()
    await saveMyProfile(t.deps, { idToken: 'tok-biw', groupId: t.group.id, nicknames: [], role: ' ' })
    expect(t.row(BIW)).toMatchObject({ nicknames: [], role: null })
  })

  it('a user ID in the body is ignored: only the requester’s row changes', async () => {
    const t = setup()
    await saveMyProfile(t.deps, {
      idToken: 'tok-biw', groupId: t.group.id, lineUserId: TON, userId: TON, nicknames: ['x'], role: 'y',
    })
    expect(t.row(TON)).toMatchObject({ nicknames: ['ต้น'], role: 'บัญชี' })
    expect(t.row(BIW)).toMatchObject({ nicknames: ['x'], role: 'y' })
  })

  it('a person who left the group cannot load or save', async () => {
    const t = setup()
    await t.send(ev.memberLeft({ userIds: [BIW] }))
    const body = { idToken: 'tok-biw', groupId: t.group.id, nicknames: ['x'], role: 'y' }
    expect((await loadMyProfile(t.deps, body)).status).toBe(403)
    expect((await saveMyProfile(t.deps, body)).status).toBe(403)
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว'], role: 'ออกแบบ' })
  })

  it('refuses a bad token, a bad group and bad values', async () => {
    const t = setup()
    const ok = { idToken: 'tok-biw', groupId: t.group.id, nicknames: ['บิว'], role: 'ออกแบบ' }
    expect((await saveMyProfile(t.deps, { ...ok, idToken: 'nope' })).status).toBe(401)
    expect((await saveMyProfile(t.deps, { ...ok, groupId: 'x' })).status).toBe(400)
    expect((await saveMyProfile(t.deps, { ...ok, nicknames: 'บิว' })).status).toBe(400)
    expect((await saveMyProfile(t.deps, { ...ok, nicknames: Array.from({ length: 11 }, (_, i) => `n${i}`) })).status).toBe(400)
    expect((await saveMyProfile(t.deps, { ...ok, nicknames: ['x'.repeat(51)] })).status).toBe(400)
    expect((await saveMyProfile(t.deps, { ...ok, role: 'x'.repeat(101) })).status).toBe(400)
    expect((await saveMyProfile(t.deps, { ...ok, role: null })).status).toBe(400)
    expect(t.row(BIW)).toMatchObject({ nicknames: ['บิว'], role: 'ออกแบบ' })
  })
})
