import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishGoogleSignIn } from '@/server/google/callback'
import { driveAccessCheckJob } from '@/server/google/access-check'
import { DISCONNECTED_TEXT, disconnectGoogle } from '@/server/google/disconnect'
import { ensureDriveFolders, driveDeadline } from '@/server/google/drive-folders'
import { startGoogleSignIn } from '@/server/google/start'
import { googleStatus } from '@/server/google/status'
import { liffUrl } from '@/server/liff-links'
import type { LineMessage } from '@/server/line/types'
import { AdapterError } from '@/server/log'
import { handleTickRequest } from '@/server/tick/handle-request'
import { makeTestDeps, TEST_LIFF_ID, TEST_NOW, tickRequest } from './harness'

// #82: the person disconnects Google Drive from the LIFF Google view. Google revokes the
// grant, the account is marked revoked (so file saving pauses), the main group gets one
// "the Owner disconnected" card instead of #14's "access lost" card, and signing in again
// works as after #14.

const OWNER = 'Uowner1'
const OWNER_TOKEN = 'idtok-owner'
const OTHER = 'Uother'
const OTHER_TOKEN = 'idtok-other'
const MAIN_LINE_GROUP = 'Cmain'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

type H = ReturnType<typeof makeTestDeps>

function setup() {
  const h = makeTestDeps()
  h.line.idTokens.set(OWNER_TOKEN, { lineUserId: OWNER, displayName: 'Owner Name' })
  h.line.idTokens.set(OTHER_TOKEN, { lineUserId: OTHER, displayName: 'Other' })
  return h
}

async function seedProject(h: H) {
  const g = h.store.seedGroup({ lineGroupId: MAIN_LINE_GROUP, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'Owner Name' })
  h.line.groupMemberCounts.set(MAIN_LINE_GROUP, 3)
  expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  return { groupId: g.id, projectId: h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string }
}

async function signIn(h: H, idToken: string, n: number) {
  h.google.exchangeResult = {
    refreshToken: `rt-${n}`, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: `g-sub-${n}`, email: `p${n}@example.com`,
  }
  const res = await startGoogleSignIn(h.deps, { idToken })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  expect(await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'c', state }), h.defer)).toBe('ok')
  await h.runDeferred()
}

const accountOf = (h: H, n: number) => h.store.tables.google_accounts.find((a) => a.googleSubject === `g-sub-${n}`)!

function buttons(m: LineMessage) {
  if (m.type !== 'template') throw new Error('not a template')
  return m.template
}

async function connected(h: H) {
  const p = await seedProject(h)
  await signIn(h, OWNER_TOKEN, 1)
  h.line.pushes = []
  h.store.tables.push_log = []
  return p
}

describe('disconnect Google Drive (#82)', () => {
  it('revokes at Google, marks the account and posts one "disconnected" card in the main group', async () => {
    const h = setup()
    const { projectId } = await connected(h)
    const connectionsBefore = structuredClone(h.store.tables.drive_connections)

    const res = await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)
    expect(res).toEqual({ status: 200, body: { disconnected: true } })
    expect(h.google.revokeCalls).toEqual(['rt-1'])
    expect(accountOf(h, 1)).toMatchObject({ tokenStatus: 'revoked', refreshTokenCiphertext: null })
    // The connection row stays as history, as #14 leaves it.
    expect(h.store.tables.drive_connections).toEqual(connectionsBefore)

    await h.runDeferred()
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(MAIN_LINE_GROUP)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'drive_disconnected', lineTargetId: MAIN_LINE_GROUP })])
    const card = buttons(h.line.pushes[0].messages[0])
    expect(card.text).toBe(DISCONNECTED_TEXT.card)
    expect(card.actions).toEqual([{ type: 'uri', label: DISCONNECTED_TEXT.button, uri: liffUrl(TEST_LIFF_ID, 'google') }])
    expect(card.text.length).toBeLessThanOrEqual(160)
    expect(card.actions[0].label.length).toBeLessThanOrEqual(20)

    // The page then reads "sign in again", and later Drive runs and the daily access check
    // post no #14 "access lost" card: the disconnect did the marking.
    expect((await googleStatus(h.deps, { idToken: OWNER_TOKEN })).body).toMatchObject({ connected: false, signInAgain: true })
    await ensureDriveFolders(h.deps, projectId, driveDeadline(h.deps.now()))
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [driveAccessCheckJob])).status).toBe(200)
    await h.runDeferred()
    expect(h.line.pushes).toHaveLength(1)
  })

  it('still marks the account when Google answers 400 (the grant was already gone)', async () => {
    const h = setup()
    await connected(h)
    h.google.revokedRefreshTokens.add('rt-1')
    const res = await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)
    expect(res.status).toBe(200)
    expect(accountOf(h, 1).tokenStatus).toBe('revoked')
  })

  it('changes nothing and answers 502 when Google does not answer', async () => {
    const h = setup()
    await connected(h)
    h.google.revokeError = new AdapterError('google revoke 503')
    const res = await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)
    expect(res).toEqual({ status: 502, body: { error: 'google_failed' } })
    await h.runDeferred()
    expect(accountOf(h, 1)).toMatchObject({ tokenStatus: 'valid' })
    expect(accountOf(h, 1).refreshTokenCiphertext).not.toBeNull()
    expect(h.line.pushes).toEqual([])
  })

  it('a second press answers 409 not_connected and posts no second card', async () => {
    const h = setup()
    await connected(h)
    expect((await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)).status).toBe(200)
    await h.runDeferred()
    const res = await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)
    expect(res).toEqual({ status: 409, body: { error: 'not_connected' } })
    await h.runDeferred()
    expect(h.google.revokeCalls).toEqual(['rt-1'])
    expect(h.line.pushes).toHaveLength(1)
  })

  it('touches only the requester\'s own account; a person who owns no group gets no card', async () => {
    const h = setup()
    await connected(h)
    await signIn(h, OTHER_TOKEN, 2) // connected, but the Owner of nothing
    h.line.pushes = []
    expect((await disconnectGoogle(h.deps, { idToken: OTHER_TOKEN }, h.defer)).status).toBe(200)
    await h.runDeferred()
    expect(accountOf(h, 2).tokenStatus).toBe('revoked')
    expect(accountOf(h, 1).tokenStatus).toBe('valid')
    expect(h.google.revokeCalls).toEqual(['rt-2'])
    expect(h.line.pushes).toEqual([])
  })

  it('refuses a request without a verified LINE login', async () => {
    const h = setup()
    await connected(h)
    expect((await disconnectGoogle(h.deps, { idToken: 'nope' }, h.defer)).status).toBe(401)
    expect(await disconnectGoogle(h.deps, {}, h.defer)).toMatchObject({ status: 401 })
    expect(h.google.revokeCalls).toEqual([])
  })

  it('signing in again with the same account connects it again', async () => {
    const h = setup()
    await connected(h)
    await disconnectGoogle(h.deps, { idToken: OWNER_TOKEN }, h.defer)
    await h.runDeferred()
    h.google.revokedRefreshTokens.delete('rt-1') // Google issues a fresh grant on consent
    await signIn(h, OWNER_TOKEN, 1)
    expect((await googleStatus(h.deps, { idToken: OWNER_TOKEN })).body).toMatchObject({ connected: true, canChange: true })
  })
})
