import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finishGoogleSignIn } from '@/server/google/callback'
import { startGoogleSignIn } from '@/server/google/start'
import { liffUrl } from '@/server/liff-links'
import { retryKeyFrom } from '@/server/line/push-budget'
import type { LineEvent, LineMessage } from '@/server/line/types'
import { MEMBER_LEFT_TEXT } from '@/server/members/card'
import { memberCheckJob } from '@/server/members/daily-check'
import { OWNER_NEEDED_TEXT } from '@/server/members/owner-left'
import { TAKEOVER_CARD_TEXT } from '@/server/owner-change/card'
import { loadSetup } from '@/server/setup/load'
import { confirmOwner } from '@/server/setup/confirm'
import { handleTickRequest } from '@/server/tick/handle-request'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { TEST_LIFF_ID, TEST_NOW, ev, makeTestDeps, signedRequest, tickRequest, webhookBody } from './harness'

// #30 part A through the event seam: a signed memberLeft webhook for the Owner, the LIFF
// Owner page (/api/setup/confirm-owner), the Google callback and pg_cron ticks go in;
// groups, projects, drive_connections and task_prompts rows, pushes, replies and Drive
// calls come out. The fake clock moves only when a test moves it.

const OWNER = 'Uowner1'
const PIM = 'Upim'
const TON = 'Uton'
const MAIN = 'Cmain'
const SUB = 'Csub'
const TOKEN: Record<string, string> = { [OWNER]: 'idtok-owner', [PIM]: 'idtok-pim', [TON]: 'idtok-ton' }
const bkk = (s: string) => new Date(`${s}+07:00`)
const MON_9 = bkk('2026-11-16T09:00:00') // a Monday: the weekly insight and the daily reminders run

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

type H = ReturnType<typeof makeTestDeps>

/** A Project whose main group OWNER set up and confirmed, with PIM and TON as live Members,
 *  OWNER signed in to Google (account 1) and the Drive folders made. */
async function setup() {
  const h = makeTestDeps()
  h.store.pushClock = () => h.deps.now()
  for (const [id, tok] of Object.entries(TOKEN)) h.line.idTokens.set(tok, { lineUserId: id, displayName: id })
  const g = h.store.seedGroup({ lineGroupId: MAIN, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: g.id, lineUserId: OWNER, displayName: 'เจ้าของ' })
  h.store.seedMember({ groupId: g.id, lineUserId: PIM, displayName: 'พิม' })
  h.store.seedMember({ groupId: g.id, lineUserId: TON, displayName: 'ต้น' })
  h.line.groupMemberCounts.set(MAIN, 3)
  expect((await h.store.confirmGroupOwner(g.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((r) => r.id === g.id)!.projectId as string
  expect(await signIn(h, OWNER, 1)).toBe('ok')
  h.line.pushes = []
  h.google.driveCalls = []
  return { ...h, groupId: g.id, projectId }
}

/** Google sign-in from start to callback with Google account `n`, then the deferred work. */
async function signIn(h: H, who: string, n: number) {
  h.google.exchangeResult = {
    refreshToken: `rt-${n}`, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'],
    subject: `g-sub-${n}`, email: `p${n}@example.com`,
  }
  const res = await startGoogleSignIn(h.deps, { idToken: TOKEN[who] })
  const state = new URL((res.body as { url: string }).url).searchParams.get('state') as string
  const outcome = await finishGoogleSignIn(h.deps, new URLSearchParams({ code: 'code-1', state }), h.defer)
  await h.runDeferred()
  return outcome
}

async function send(h: H, ...events: LineEvent[]) {
  expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
  await h.runDeferred()
}

/** The LIFF Owner page's confirm button, pressed by `who`. */
async function press(h: H, groupId: string, who: string) {
  const res = await confirmOwner(h.deps, { idToken: TOKEN[who], groupId }, h.defer)
  await h.runDeferred()
  return res
}

async function tickAt(h: H, at: Date) {
  h.setNow(at)
  expect((await handleTickRequest(tickRequest(), h.deps, h.defer)).status).toBe(200)
  await h.runDeferred()
}

const group = (h: H, id: string) => h.store.tables.groups.find((g) => g.id === id)!
const prompts = (h: H, id: string) => h.store.tables.owner_prompts.filter((p) => p.groupId === id)
const folderOf = (h: H, id: string) => h.store.tables.group_setups.find((r) => r.groupId === id)?.driveFolderId ?? null
const accountId = (h: H, n: number) => h.store.tables.google_accounts.find((a) => a.googleSubject === `g-sub-${n}`)!.id

/** Every text in a Flex tree. */
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!node || typeof node !== 'object') return []
  const o = node as Record<string, unknown>
  return [...(o.type === 'text' && typeof o.text === 'string' ? [o.text] : []), ...Object.values(o).flatMap(texts)]
}

/** Every uri action in a Flex message. */
function uris(m: LineMessage): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const a = n.action as { type?: string; uri?: string } | undefined
    if (a?.type === 'uri' && a.uri) out.push(a.uri)
    Object.values(n).forEach(walk)
  }
  if (m.type === 'flex') walk(m.contents)
  return out
}

const isOwnerCard = (m: LineMessage) => texts(m.type === 'flex' ? m.contents : null).includes(OWNER_NEEDED_TEXT.title)

describe('the Owner leaves (#30)', () => {
  it('pauses the group (owner_left_at set, no confirmed Owner) and posts one owner_needed card as one push', async () => {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN, eventId: 'ev-left' }))

    expect(group(t, t.groupId)).toMatchObject({ ownerLeftAt: TEST_NOW, ownerConfirmedAt: null, nominatedOwnerLineUserId: OWNER })
    expect(t.line.pushes).toHaveLength(1)
    const push = t.line.pushes[0]
    expect(push.to).toBe(MAIN)
    expect(isOwnerCard(push.messages[0])).toBe(true)
    expect(uris(push.messages[0])).toEqual([liffUrl(TEST_LIFF_ID, 'owner', t.groupId)])
    // Counted by the push budget, under the card's own retry key.
    expect(t.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'owner_needed', lineTargetId: MAIN, messageCount: 3 })])
    expect(push.retryKey).toBe(retryKeyFrom(`owner_needed:${prompts(t, t.groupId)[0].id}`))
    // One open owner_needed card, about the old Owner.
    expect(prompts(t, t.groupId)).toEqual([expect.objectContaining({ subjectLineUserId: OWNER, answer: null })])
  })

  it('posts the owner card and the member-left card when the Owner also held open Tasks', async () => {
    const t = await setup()
    t.store.seedTask({ groupId: t.groupId, title: 'ทำสไลด์', createdByLineUserId: OWNER, status: 'in_process', assigneeLineUserId: OWNER })
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    expect(t.line.pushes).toHaveLength(2)
    expect(isOwnerCard(t.line.pushes[0].messages[0])).toBe(true)
    expect(isOwnerCard(t.line.pushes[1].messages[0])).toBe(false)
    expect(texts(t.line.pushes[1].messages[0])).toContain(MEMBER_LEFT_TEXT.body(1))
  })

  it('a redelivered leave posts no second card', async () => {
    const t = await setup()
    const leave = ev.memberLeft({ userIds: [OWNER], groupId: MAIN, eventId: 'ev-left' })
    await send(t, leave)
    await send(t, { ...leave, deliveryContext: { isRedelivery: true } })
    expect(t.line.pushes).toHaveLength(1)
  })

  it('a redelivery after the pause was saved but before the ledger row still posts the card, once', async () => {
    const t = await setup()
    t.store.failNext('recordWebhookEvent')
    const leave = ev.memberLeft({ userIds: [OWNER], groupId: MAIN, eventId: 'ev-left' })
    const res = await handleWebhookRequest(signedRequest(webhookBody(leave)), t.deps, t.defer)
    expect(res.status).toBe(500)
    await t.runDeferred()
    expect(group(t, t.groupId).ownerLeftAt).toEqual(TEST_NOW)
    expect(t.line.pushes).toHaveLength(0)
    await send(t, { ...leave, deliveryContext: { isRedelivery: true } })
    expect(t.line.pushes).toHaveLength(1)
    expect(prompts(t, t.groupId)).toHaveLength(1)
  })

  it('a Member who is not the Owner leaving changes no Owner state', async () => {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [PIM], groupId: MAIN }))
    expect(group(t, t.groupId)).toMatchObject({ ownerLeftAt: null, ownerConfirmedAt: TEST_NOW })
    expect(t.line.pushes).toEqual([])
  })

  it('a nominee who never confirmed is not an Owner: leaving changes nothing', async () => {
    const h = makeTestDeps()
    const g = h.store.seedGroup({ lineGroupId: 'Csetup', nominatedOwnerLineUserId: PIM })
    h.store.seedMember({ groupId: g.id, lineUserId: PIM, displayName: 'พิม' })
    await send(h, ev.memberLeft({ userIds: [PIM], groupId: 'Csetup' }))
    expect(group(h, g.id).ownerLeftAt).toBeNull()
    expect(h.line.pushes).toEqual([])
    expect(h.store.tables.owner_prompts).toEqual([])
  })

  it('near the quota the push is skipped, the card stays open, and the Summary command replies with it', async () => {
    const t = await setup()
    t.line.quota = { limit: 300, used: 299 }
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    expect(t.line.pushes).toEqual([])
    expect(prompts(t, t.groupId)).toEqual([expect.objectContaining({ answer: null })])

    await send(t, ev.groupText({ text: 'NongJoDII summarize', groupId: MAIN, userId: PIM, replyToken: 'rt-sum' }))
    expect(t.line.pushes).toEqual([])
    const reply = t.line.replies.find((r) => r.replyToken === 'rt-sum')!
    expect(reply.messages).toHaveLength(1)
    expect(isOwnerCard(reply.messages[0])).toBe(true)
  })
})

describe('while the group has no Owner (#30)', () => {
  it('Summaries make no AI call; the reply is the owner card', async () => {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    await send(t, ev.groupText({ text: 'NongJoDII summarize', groupId: MAIN, userId: PIM, replyToken: 'rt-sum' }))
    expect(t.llm.requests).toEqual([])
    expect(t.store.tables.summaries).toEqual([])
    expect(isOwnerCard(t.line.replies.find((r) => r.replyToken === 'rt-sum')!.messages[0])).toBe(true)
  })

  it('the weekly insight pauses; the daily reminders still post', async () => {
    const t = await setup()
    t.store.seedTask({ groupId: t.groupId, title: 'ส่งรายงาน', createdByLineUserId: PIM, dueAt: bkk('2026-11-16T18:00:00') })
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    t.line.pushes = []
    await tickAt(t, MON_9)
    expect(t.store.tables.weekly_insights).toEqual([])
    expect(t.store.tables.push_log.map((p) => p.purpose)).not.toContain('weekly_insight')
    expect(t.store.tables.push_log.map((p) => p.purpose)).toContain('reminder')
  })

  it('Drive runs for the old Owner leave the Project alone (no confirmed Owner)', async () => {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    expect(await t.store.listConfirmedOwnerProjects(OWNER)).toEqual([])
  })
})

describe('a new Owner takes over (#30)', () => {
  async function ownerLeft() {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    t.line.pushes = []
    t.google.driveCalls = []
    return t
  }

  it('the Owner page offers the take-over to a live Member', async () => {
    const t = await ownerLeft()
    const res = await loadSetup(t.deps, { idToken: TOKEN[PIM], groupId: t.groupId })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'in_project', ownerNeeded: true })
  })

  it('LINE login alone makes the presser the nominee but changes no Owner until Drive is connected', async () => {
    const t = await ownerLeft()
    const res = await press(t, t.groupId, PIM)
    expect(res).toEqual({ status: 200, body: { state: 'needs_drive' } })
    expect(group(t, t.groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerConfirmedAt: null, ownerLeftAt: TEST_NOW })
    expect(t.store.tables.projects.find((p) => p.id === t.projectId)!.ownerLineUserId).toBe(OWNER)
    expect(t.store.tables.drive_connections.map((c) => c.status)).toEqual(['active'])
    expect(prompts(t, t.groupId)[0].answer).toBeNull()
  })

  it('LINE login then Drive: the change takes effect, the old connection is retired, folder IDs cleared, old files stay', async () => {
    const t = await ownerLeft()
    const oldConnection = structuredClone(t.store.tables.drive_connections[0])
    const oldFolder = folderOf(t, t.groupId)
    expect(oldFolder).not.toBeNull()
    await press(t, t.groupId, PIM)
    const later = new Date(TEST_NOW.getTime() + 60 * 60_000)
    t.setNow(later)

    expect(await signIn(t, PIM, 2)).toBe('ok')

    // PIM is the Project's owner and the main group's confirmed Owner; the pause is over.
    expect(t.store.tables.projects.find((p) => p.id === t.projectId)!.ownerLineUserId).toBe(PIM)
    expect(group(t, t.groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerConfirmedAt: later, ownerLeftAt: null })
    // The old connection is kept as history, retired; the new Owner's Drive holds the new one.
    expect(t.store.tables.drive_connections).toEqual([
      { ...oldConnection, status: 'replaced', statusChangedAt: later },
      expect.objectContaining({ projectId: t.projectId, googleAccountId: accountId(t, 2), status: 'active' }),
    ])
    // The folder IDs were cleared, and the Drive run made new folders in the new Drive.
    expect(folderOf(t, t.groupId)).not.toBe(oldFolder)
    expect(folderOf(t, t.groupId)).not.toBeNull()
    // Nothing in the old Drive is deleted or moved: the old folder is still there, and the
    // Drive run only made, read and shared folders.
    expect(t.google.folders.has(oldFolder as string)).toBe(true)
    expect(t.google.driveCalls.every((c) => /^(create|get|share):/.test(c))).toBe(true)
    // The card is answered.
    expect(prompts(t, t.groupId)).toEqual([expect.objectContaining({ answer: 'owner_confirmed', answeredByLineUserId: PIM })])
    // The Owner page now shows PIM as the confirmed Owner.
    expect((await press(t, t.groupId, PIM)).body).toEqual({ state: 'confirmed', alreadyConfirmed: true })
  })

  it('a presser already signed in to Google becomes the Owner at once', async () => {
    const t = await ownerLeft()
    // PIM signed in to Google before (for example as Owner of another Project).
    expect(await signIn(t, PIM, 2)).toBe('ok')
    expect(group(t, t.groupId).ownerConfirmedAt).toBeNull()
    t.google.driveCalls = []

    const res = await press(t, t.groupId, PIM)
    expect(res).toEqual({ status: 200, body: { state: 'confirmed', alreadyConfirmed: false } })
    expect(group(t, t.groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerLeftAt: null })
    expect(group(t, t.groupId).ownerConfirmedAt).not.toBeNull()
    // The deferred Drive run made the new Owner's folders.
    expect(t.google.driveCalls.some((c) => c.startsWith('create:'))).toBe(true)
    expect(t.store.tables.drive_connections.find((c) => c.status === 'active')!.googleAccountId).toBe(accountId(t, 2))
  })

  it('someone other than the person who took the card cannot confirm, even with Drive', async () => {
    const t = await ownerLeft()
    await press(t, t.groupId, PIM)
    expect(await press(t, t.groupId, TON)).toEqual({ status: 403, body: { error: 'not_nominee' } })
    expect(await signIn(t, TON, 3)).toBe('ok')
    expect(group(t, t.groupId)).toMatchObject({ nominatedOwnerLineUserId: PIM, ownerConfirmedAt: null })
    expect(t.store.tables.projects.find((p) => p.id === t.projectId)!.ownerLineUserId).toBe(OWNER)
  })

  it('a nominee who leaves the group frees the take-over for another Member, with no second card', async () => {
    const t = await ownerLeft()
    await press(t, t.groupId, PIM)
    await send(t, ev.memberLeft({ userIds: [PIM], groupId: MAIN }))
    expect(t.line.pushes).toEqual([]) // the group's card is still open
    expect(await press(t, t.groupId, TON)).toEqual({ status: 200, body: { state: 'needs_drive' } })
    expect(group(t, t.groupId).nominatedOwnerLineUserId).toBe(TON)
  })

  it('the old Owner who rejoins is a Member again, not the Owner', async () => {
    const t = await ownerLeft()
    await send(t, ev.memberJoined({ userIds: [OWNER], groupId: MAIN, timestamp: TEST_NOW.getTime() + 1000 }))
    expect(group(t, t.groupId)).toMatchObject({ ownerConfirmedAt: null, ownerLeftAt: TEST_NOW })
  })

  it('the weekly insight runs again after the change', async () => {
    const t = await ownerLeft()
    t.store.seedTask({ groupId: t.groupId, title: 'ส่งรายงาน', createdByLineUserId: PIM })
    await press(t, t.groupId, PIM)
    await signIn(t, PIM, 2)
    await tickAt(t, MON_9)
    expect(t.store.tables.weekly_insights).toHaveLength(1)
  })

  it('a Sub group whose Owner left pauses too, but its Owner cannot change there', async () => {
    const t = await ownerLeft()
    const sub = t.store.seedGroup({
      lineGroupId: SUB, projectId: t.projectId, nominatedOwnerLineUserId: PIM, ownerConfirmedAt: TEST_NOW,
    })
    t.store.seedMember({ groupId: sub.id, lineUserId: PIM, displayName: 'พิม' })
    t.store.seedMember({ groupId: sub.id, lineUserId: TON, displayName: 'ต้น' })
    t.line.groupMemberCounts.set(SUB, 2)
    await send(t, ev.memberLeft({ userIds: [PIM], groupId: SUB }))
    expect(group(t, sub.id)).toMatchObject({ ownerLeftAt: TEST_NOW, ownerConfirmedAt: null })
    expect(await press(t, sub.id, TON)).toEqual({ status: 409, body: { error: 'sub_group' } })
  })
})

describe('the Owner change reaches #31 and #32', () => {
  const isTakeoverCard = (m: LineMessage) => texts(m.type === 'flex' ? m.contents : null).includes(TAKEOVER_CARD_TEXT.title)

  it('a new Owner through LINE login and Drive posts the Sub group take-over question once, in the main group', async () => {
    const t = await setup()
    const sub = t.store.seedGroup({
      lineGroupId: SUB, projectId: t.projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW,
    })
    t.store.seedMember({ groupId: sub.id, lineUserId: OWNER, displayName: 'เจ้าของ' })
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    t.line.pushes = []
    await press(t, t.groupId, PIM)
    expect(await signIn(t, PIM, 2)).toBe('ok')
    const takeover = t.line.pushes.filter((p) => p.messages.some(isTakeoverCard))
    expect(takeover).toHaveLength(1)
    expect(takeover[0].to).toBe(MAIN)
    expect(uris(takeover[0].messages[0])).toEqual([liffUrl(TEST_LIFF_ID, 'takeover', t.groupId)])
    // The Sub group waits on the question, not detached.
    expect(t.store.tables.groups.find((g) => g.id === sub.id)!.projectId).toBe(t.projectId)
  })

  it('a new Owner with no Sub groups gets no take-over card', async () => {
    const t = await setup()
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    t.line.pushes = []
    await press(t, t.groupId, PIM)
    await signIn(t, PIM, 2)
    expect(t.line.pushes.some((p) => p.messages.some(isTakeoverCard))).toBe(false)
  })

  it('the daily member check that finds the Owner gone pauses the group and posts the owner card, as a leave event would', async () => {
    const t = await setup()
    t.line.groupNames.set(MAIN, 'ทีมหลัก')
    for (const u of [PIM, TON]) t.line.profiles.set(`${MAIN}:${u}`, u) // OWNER has no profile: gone
    await tickAt(t, bkk('2026-11-16T08:00:00'))
    expect(group(t, t.groupId)).toMatchObject({ ownerConfirmedAt: null })
    expect(group(t, t.groupId).ownerLeftAt).not.toBeNull()
    expect(t.line.pushes.filter((p) => p.messages.some(isOwnerCard))).toHaveLength(1)
    expect(prompts(t, t.groupId)).toHaveLength(1)
  })
})


describe('review follow-ups (#74)', () => {
  const isTakeoverCard = (m: LineMessage) => texts(m.type === 'flex' ? m.contents : null).includes(TAKEOVER_CARD_TEXT.title)
  const ownerCards = (h: H) => h.line.pushes.filter((p) => p.messages.some(isOwnerCard))

  it('the daily member check failing between the leave and the Owner mark: a later tick marks the Owner and posts the card', async () => {
    const t = await setup()
    t.line.groupNames.set(MAIN, 'ทีมหลัก')
    for (const u of [PIM, TON]) t.line.profiles.set(`${MAIN}:${u}`, u) // OWNER has no profile: gone
    t.store.failNext('markOwnerLeft')
    t.setNow(bkk('2026-11-16T08:00:00'))
    expect((await handleTickRequest(tickRequest(), t.deps, t.defer, [memberCheckJob])).status).toBe(200)
    await t.runDeferred()
    // The leave was written, the Owner mark was not: no pause, no card yet.
    expect(t.store.tables.group_members.find((m) => m.groupId === t.groupId && m.lineUserId === OWNER)!.leftAt).not.toBeNull()
    expect(group(t, t.groupId).ownerLeftAt).toBeNull()
    expect(ownerCards(t)).toHaveLength(0)

    await tickAt(t, bkk('2026-11-16T08:15:00'))
    expect(group(t, t.groupId)).toMatchObject({ ownerConfirmedAt: null })
    expect(group(t, t.groupId).ownerLeftAt).not.toBeNull()
    expect(ownerCards(t)).toHaveLength(1)
    await tickAt(t, bkk('2026-11-16T08:30:00'))
    expect(ownerCards(t)).toHaveLength(1)
  })

  it('the weekly insight skips a Sub group waiting on the take-over question (no confirmed Owner)', async () => {
    const t = await setup()
    const sub = t.store.seedGroup({ lineGroupId: SUB, projectId: t.projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: null })
    expect((await t.store.listWeeklySummaryGroups(1)).map((g) => g.groupId)).not.toContain(sub.id)
    expect((await t.store.listWeeklySummaryGroups(1)).map((g) => g.groupId)).toContain(t.groupId)
  })

  it('the Google callback finishes a second Owner change too; the Sub group the first new Owner took over is asked by the next', async () => {
    const t = await setup()
    const sub = t.store.seedGroup({
      lineGroupId: SUB, projectId: t.projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW,
    })
    t.store.seedMember({ groupId: sub.id, lineUserId: OWNER, displayName: 'เจ้าของ' })
    // OWNER -> PIM through LINE login, then the Google callback; PIM takes the Sub group over.
    await send(t, ev.memberLeft({ userIds: [OWNER], groupId: MAIN }))
    await press(t, t.groupId, PIM)
    expect(await signIn(t, PIM, 2)).toBe('ok')
    expect((await t.store.answerSubgroupTakeover(t.projectId, [sub.id])).outcome).toBe('saved')
    expect(group(t, sub.id)).toMatchObject({ nominatedOwnerLineUserId: PIM })
    expect(group(t, sub.id).ownerConfirmedAt).not.toBeNull()

    // PIM leaves; TON takes the card, then signs in to Google: the callback runs the change.
    t.setNow(new Date(TEST_NOW.getTime() + 86_400_000))
    await send(t, ev.memberLeft({ userIds: [PIM], groupId: MAIN, timestamp: t.deps.now().getTime() }))
    t.line.pushes = []
    expect((await press(t, t.groupId, TON)).body).toEqual({ state: 'needs_drive' })
    expect(await signIn(t, TON, 3)).toBe('ok')
    expect(t.store.tables.projects.find((p) => p.id === t.projectId)!.ownerLineUserId).toBe(TON)
    expect(group(t, t.groupId)).toMatchObject({ nominatedOwnerLineUserId: TON, ownerLeftAt: null })
    // The Sub group cannot stay on PIM (same-Owner rule): it waits on TON's question.
    expect(group(t, sub.id)).toMatchObject({ projectId: t.projectId, nominatedOwnerLineUserId: PIM, ownerConfirmedAt: null })
    expect(t.line.pushes.filter((p) => p.messages.some(isTakeoverCard))).toHaveLength(1)
  })
})
