import { randomUUID } from 'node:crypto'
import { seal } from '@/server/crypto/secretbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveDeadline } from '@/server/google/drive-folders'
import type { LineMessage } from '@/server/line/types'
import { answerTakeover, loadTakeover } from '@/server/owner-change/answer'
import { DETACHED_CARD_TEXT, TAKEOVER_CARD_TEXT } from '@/server/owner-change/card'
import { announceDetached, TAKEOVER_WAIT_MS, takeoverExpiryJob } from '@/server/owner-change/detach'
import { startProjectOwnerChange } from '@/server/owner-change/start'
import { handleTickRequest } from '@/server/tick/handle-request'
import { TICK_JOBS } from '@/server/tick/run-tick'
import { bangkokMonthRange } from '@/server/time/bangkok'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, TEST_KEY, TEST_NOW, tickRequest, webhookBody } from './harness'

// #31 Project Owner change: the Sub group take-over question. Event seam with a fake clock:
// the entry function (called by #30's confirm), the LIFF answer endpoints, the webhook (a
// Summary in a Sub group) and the tick go in; pushes, replies, stored rows and usage come out.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const OLD = 'Uold'
const NEW = 'Unew'
const PENDING = 'Upending'
const MEMBER = 'Umember'
const MIN = 60_000
const ANSWER = JSON.stringify({ summary: 'สรุป', tasks: [] })

type H = ReturnType<typeof makeTestDeps>

/** A Project owned by OLD: main group Cmain and two Sub groups, all confirmed for OLD, each
 *  with a Drive folder, and an active Drive connection. Then the main group names NEW as its
 *  nominee, as #30 does after OLD left. ID tokens: tok-<user>. */
function seedProject(h: H) {
  const { store } = h
  const projectId = randomUUID()
  store.tables.line_users.push({ lineUserId: OLD, displayName: 'เจ้าของเดิม' })
  store.tables.projects.push({ id: projectId, ownerLineUserId: OLD, driveProjectFolderId: 'fold-project' })
  const group = (lineGroupId: string, name: string, isMain: boolean) => {
    const g = store.seedGroup({ lineGroupId, name, projectId, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: new Date(TEST_NOW) })
    store.tables.group_setups.push({
      groupId: g.id, isMain, featureSaveFiles: true, ownerNominatedByLineUserId: OLD, ownerNominatedAt: new Date(TEST_NOW),
      driveFolderId: `fold-${lineGroupId}`,
    })
    store.seedMember({ groupId: g.id, lineUserId: OLD, displayName: 'เจ้าของเดิม' })
    store.seedMember({ groupId: g.id, lineUserId: MEMBER, displayName: 'สมาชิก' })
    return g
  }
  const main = group('Cmain', 'ทีมหลัก', true)
  const subA = group('CsubA', 'ทีมออกแบบ', false)
  const subB = group('CsubB', 'ทีมพิช', false)
  store.seedMember({ groupId: main.id, lineUserId: NEW, displayName: 'เจ้าของใหม่' })
  store.seedMember({ groupId: main.id, lineUserId: PENDING, displayName: 'คนถัดไป' })
  store.tables.google_accounts.push({
    id: 'ga-old', lineUserId: OLD, googleSubject: 'sub-old', email: null, grantedScopes: [],
    refreshTokenCiphertext: null, tokenStatus: 'valid', updatedAt: new Date(TEST_NOW),
  })
  store.tables.drive_connections.push({ id: 'dc-old', projectId, googleAccountId: 'ga-old', status: 'active' })
  // #30: the main group names the new Owner (not confirmed yet).
  const mainRow = store.tables.groups.find((g) => g.id === main.id)!
  Object.assign(mainRow, { nominatedOwnerLineUserId: NEW, ownerConfirmedAt: null })
  for (const u of [OLD, NEW, PENDING, MEMBER]) h.line.idTokens.set(`tok-${u}`, { lineUserId: u, displayName: null })
  return { projectId, main, subA, subB }
}

const groupRow = (h: H, id: string) => h.store.tables.groups.find((g) => g.id === id)!
const setupRow = (h: H, id: string) => h.store.tables.group_setups.find((r) => r.groupId === id)!
const altTexts = (ms: LineMessage[]) => ms.map((m) => (m.type === 'flex' ? m.altText : m.type === 'text' ? m.text : ''))
const uriOf = (m: LineMessage) => JSON.stringify(m).match(/https:\/\/liff\.line\.me\/[^"]+/)?.[0]

async function change(h: H, projectId: string, who = NEW) {
  return startProjectOwnerChange(h.deps, { projectId, newOwnerLineUserId: who, now: h.deps.now() })
}

async function answer(h: H, groupId: string, who: string, choice: 'takeover' | 'detach') {
  const res = await answerTakeover(h.deps, { idToken: `tok-${who}`, groupId, choice }, h.defer)
  await h.runDeferred()
  return res
}

async function tick(h: H, at: Date) {
  h.setNow(at)
  expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [takeoverExpiryJob])).status).toBe(200)
  await h.runDeferred()
}

async function summarize(h: H, lineGroupId: string) {
  const before = h.line.replies.length
  const res = await handleWebhookRequest(
    signedRequest(webhookBody(ev.groupText({ text: 'NongJoDII summarize', groupId: lineGroupId, userId: MEMBER, timestamp: h.deps.now().getTime() }))),
    h.deps, h.defer,
  )
  expect(res.status).toBe(200)
  await h.runDeferred()
  return altTexts(h.line.replies.slice(before).flatMap((r) => r.messages))
}

describe('startProjectOwnerChange (#31 step 1, after the new Owner confirms for the main group)', () => {
  it('makes the new Owner the Project owner, pauses the Sub groups and posts one question card in the main group', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    const out = await change(h, projectId)
    expect(out).toEqual({ outcome: 'changed', waitingSubGroups: 2, card: 'pushed' })

    expect(h.store.tables.projects[0]).toMatchObject({ ownerLineUserId: NEW, driveProjectFolderId: null })
    expect(groupRow(h, main.id)).toMatchObject({ nominatedOwnerLineUserId: NEW, ownerConfirmedAt: TEST_NOW })
    expect(setupRow(h, main.id).driveFolderId).toBeNull()
    for (const sub of [subA, subB]) {
      // Paused: no confirmed Owner, still naming the old one, folder kept until the answer.
      expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: null })
      expect(setupRow(h, sub.id).takeoverAskedAt).toEqual(TEST_NOW)
      expect(setupRow(h, sub.id).driveFolderId).toBe(`fold-${sub.lineGroupId}`)
    }
    // The old Drive connection is history, not deleted.
    expect(h.store.tables.drive_connections).toEqual([
      { id: 'dc-old', projectId, googleAccountId: 'ga-old', status: 'replaced', statusChangedAt: TEST_NOW },
    ])

    expect(h.line.pushes).toHaveLength(1)
    const push = h.line.pushes[0]
    expect(push.to).toBe('Cmain')
    expect(altTexts(push.messages)[0]).toContain(TAKEOVER_CARD_TEXT.paused(2))
    expect(JSON.stringify(push.messages)).toContain(TAKEOVER_CARD_TEXT.changed('เจ้าของใหม่'))
    expect(uriOf(push.messages[0])).toBe(`https://liff.line.me/2000000000-abcdefgh?view=takeover&id=${main.id}`)
    expect(h.store.tables.push_log.map((p) => p.purpose)).toEqual(['owner_takeover'])
  })

  it('a repeated confirm changes nothing: no second card, the 7-day count does not restart', async () => {
    const h = makeTestDeps()
    const { projectId, subA } = seedProject(h)
    await change(h, projectId)
    h.setNow(new Date(TEST_NOW.getTime() + 3 * 86_400_000))
    expect(await change(h, projectId)).toEqual({ outcome: 'already_owner', waitingSubGroups: 2, card: 'none' })
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(TEST_NOW)
    expect(h.line.pushes).toHaveLength(1)
  })

  it('someone the main group does not name changes nothing', async () => {
    const h = makeTestDeps()
    const { projectId, subA } = seedProject(h)
    const before = structuredClone(h.store.tables)
    expect(await change(h, projectId, MEMBER)).toEqual({ outcome: 'not_nominee', waitingSubGroups: 0, card: 'none' })
    expect(h.store.tables.groups).toEqual(before.groups)
    expect(h.store.tables.projects).toEqual(before.projects)
    expect(setupRow(h, subA.id).takeoverAskedAt ?? null).toBeNull()
    expect(h.line.pushes).toHaveLength(0)
  })

  it('a Project with no Sub groups posts no card', async () => {
    const h = makeTestDeps()
    const { projectId, subA, subB } = seedProject(h)
    for (const s of [subA, subB]) groupRow(h, s.id).projectId = null
    expect(await change(h, projectId)).toEqual({ outcome: 'changed', waitingSubGroups: 0, card: 'none' })
    expect(h.line.pushes).toHaveLength(0)
  })

  it('a waiting Sub group is paused: a Summary request makes no AI call', async () => {
    const h = makeTestDeps()
    const { projectId } = seedProject(h)
    await change(h, projectId)
    const out = await summarize(h, 'CsubA')
    expect(out[0]).toContain('ยังไม่มีเจ้าของกลุ่มที่ยืนยันแล้ว')
    expect(h.llm.requests).toHaveLength(0)
    expect(h.store.tables.ai_usage).toHaveLength(0)
  })
})

describe('the take-over answer (#31 step 2, LIFF view takeover)', () => {
  it('loads the waiting Sub groups and when they detach by themselves, for the new Owner only', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    const res = await loadTakeover(h.deps, { idToken: `tok-${NEW}`, groupId: main.id })
    expect(res).toEqual({
      status: 200,
      body: {
        mainGroupName: 'ทีมหลัก',
        subGroups: [subA, subB].sort((a, b) => a.id.localeCompare(b.id)).map((g) => ({ groupId: g.id, name: g.name })),
        detachAt: new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS).toISOString(),
      },
    })
    for (const who of [OLD, MEMBER]) {
      expect(await loadTakeover(h.deps, { idToken: `tok-${who}`, groupId: main.id })).toEqual({ status: 403, body: { error: 'not_owner' } })
    }
    expect((await loadTakeover(h.deps, { idToken: 'tok-unknown', groupId: main.id })).status).toBe(401)
    // The link takes the main group only.
    expect((await loadTakeover(h.deps, { idToken: `tok-${NEW}`, groupId: subA.id })).status).toBe(404)
  })

  it('take over: plan, Fair-use cap and Drive switch to the new Owner; usage from before stays on the old Owner', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    // Usage from before the change, in a Sub group.
    h.store.seedAiUsage({ ownerLineUserId: OLD, projectId, groupId: subA.id, costUsd: 0.2, inputTokens: 1000, createdAt: new Date(TEST_NOW) })
    await change(h, projectId)
    h.setNow(new Date(TEST_NOW.getTime() + 2 * 86_400_000))

    // Not the new Owner: refused, nothing written.
    expect((await answer(h, main.id, OLD, 'takeover')).status).toBe(403)
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(TEST_NOW)

    const res = await answer(h, main.id, NEW, 'takeover')
    expect(res).toEqual({ status: 200, body: { choice: 'takeover', subGroups: 2 } })
    const at = h.deps.now()
    for (const sub of [subA, subB]) {
      expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: NEW, ownerConfirmedAt: at })
      // Folder cleared: new files go to the new Owner's Drive; old ones stay where they are.
      expect(setupRow(h, sub.id)).toMatchObject({ takeoverAskedAt: null, driveFolderId: null, ownerNominatedByLineUserId: NEW })
    }
    expect(h.line.pushes).toHaveLength(1) // the question card only; nothing more is posted

    const month = bangkokMonthRange(h.deps.now()).monthStartBkk
    const oldBefore = await h.store.sumOwnerMonthUsage(OLD, month)
    h.llm.respond({ content: ANSWER, model: TEXT_MODEL, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } })
    await h.store.upsertLineUser({ lineUserId: MEMBER, displayName: 'สมาชิก' })
    await handleWebhookRequest(signedRequest(webhookBody(ev.groupText({ text: 'งานคืบหน้า', groupId: 'CsubA', userId: MEMBER, timestamp: h.deps.now().getTime() }))), h.deps, h.defer)
    await h.runDeferred()
    await summarize(h, 'CsubA')
    expect(h.llm.requests).toHaveLength(1)
    // The new usage is the new Owner's; the old Owner's month is untouched.
    expect(h.store.tables.ai_usage.filter((u) => u.ownerLineUserId === NEW)).toHaveLength(1)
    expect(await h.store.sumOwnerMonthUsage(OLD, month)).toEqual(oldBefore)
    expect(oldBefore.costMicroUsd).toBe(200_000)
    expect((await h.store.sumOwnerMonthUsage(NEW, month)).costMicroUsd).toBe(10_000)
  })

  it('take over with Google signed in: the new Owner\'s Drive gets the Sub groups\' folders after the answer', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await h.store.upsertGoogleAccount({
      lineUserId: NEW, googleSubject: 'sub-new', email: null, grantedScopes: [],
      refreshTokenCiphertext: seal('rt-new', TEST_KEY), signedInAt: h.deps.now(),
    })
    await change(h, projectId)
    // Before the answer the waiting Sub groups get no folder in the new Drive.
    expect(setupRow(h, subA.id).driveFolderId).toBe('fold-CsubA')
    await answer(h, main.id, NEW, 'takeover')
    for (const sub of [subA, subB]) {
      const folderId = setupRow(h, sub.id).driveFolderId
      expect(folderId).not.toBeNull()
      expect(folderId).not.toBe(`fold-${sub.lineGroupId}`)
      expect(h.google.folders.get(folderId as string)?.name).toBe(sub.name)
    }
    // The new Owner's account now holds the Project; the old connection stays as history.
    expect(h.store.tables.drive_connections.map((c) => c.status).sort()).toEqual(['active', 'replaced'])
  })

  it('detach: the Sub groups leave the Project, keep their old nominee unconfirmed and each gets the setup card', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0
    const res = await answer(h, main.id, NEW, 'detach')
    expect(res).toEqual({ status: 200, body: { choice: 'detach', subGroups: 2 } })
    for (const sub of [subA, subB]) {
      expect(groupRow(h, sub.id)).toMatchObject({ projectId: null, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: null })
      expect(setupRow(h, sub.id).takeoverAskedAt).toBeNull()
      expect(setupRow(h, sub.id).driveFolderId).toBe(`fold-${sub.lineGroupId}`)
    }
    expect(h.line.pushes.map((p) => p.to).sort()).toEqual(['CsubA', 'CsubB'])
    for (const p of h.line.pushes) {
      const sub = p.to === 'CsubA' ? subA : subB
      expect(altTexts(p.messages)[0]).toContain(DETACHED_CARD_TEXT.title)
      expect(uriOf(p.messages[0])).toBe(`https://liff.line.me/2000000000-abcdefgh?view=setup&id=${sub.id}`)
    }
    // They need their own setup: a Summary request there answers with the setup card.
    expect((await summarize(h, 'CsubA')).some((t) => t.includes('ตั้งค่ากลุ่ม'))).toBe(true)
    expect(h.llm.requests).toHaveLength(0)
    // The main group keeps working with the new Owner.
    expect(groupRow(h, main.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: NEW })
    // Answered: nothing waits any more.
    expect(await answer(h, main.id, NEW, 'takeover')).toEqual({ status: 409, body: { error: 'nothing_waiting' } })
  })

  it('rejects a bad choice before anything else', async () => {
    const h = makeTestDeps()
    const { main } = seedProject(h)
    expect((await answer(h, main.id, NEW, 'maybe' as 'detach')).status).toBe(400)
  })
})

describe('no answer: the 7-day rule (tick)', () => {
  it('lists the job before the Drive setup finisher', () => {
    const names = TICK_JOBS.map((j) => j.name)
    expect(names.indexOf('subgroup_takeover_expiry')).toBeGreaterThan(-1)
    expect(names.indexOf('subgroup_takeover_expiry')).toBeLessThan(names.indexOf('drive_setup'))
  })

  it('the Sub groups wait paused for 7 days, then detach and each gets the owner_needed card (#30 part B)', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0

    await tick(h, new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS - 15 * MIN))
    for (const sub of [subA, subB]) expect(groupRow(h, sub.id).projectId).toBe(projectId)
    expect(h.line.pushes).toHaveLength(0)

    await tick(h, new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + 15 * MIN))
    for (const sub of [subA, subB]) {
      expect(groupRow(h, sub.id)).toMatchObject({
        projectId: null, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: null,
        // A fresh 7-day Owner count from the detach (#30 part B).
        ownerLeftAt: new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + 15 * MIN),
      })
      expect(setupRow(h, sub.id).takeoverAskedAt).toBeNull()
    }
    expect(h.line.pushes.map((p) => p.to).sort()).toEqual(['CsubA', 'CsubB'])
    expect(h.store.tables.push_log.map((p) => p.purpose)).toEqual(['owner_takeover', 'owner_needed', 'owner_needed'])

    // A later tick finds nothing; a late answer finds nothing waiting.
    await tick(h, new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + 30 * MIN))
    expect(h.line.pushes).toHaveLength(2)
    expect(await answer(h, main.id, NEW, 'takeover')).toEqual({ status: 409, body: { error: 'nothing_waiting' } })
  })

  it('an answer that races the detach writes nothing', async () => {
    const h = makeTestDeps()
    const { projectId, subA } = seedProject(h)
    await change(h, projectId)
    await h.store.detachExpiredTakeovers(new Date(TEST_NOW.getTime() + 1))
    expect(await h.store.answerSubgroupTakeover(projectId, [subA.id])).toEqual({ outcome: 'changed' })
    expect(groupRow(h, subA.id)).toMatchObject({ projectId: null, nominatedOwnerLineUserId: OLD })
  })

  it('the cards stop when the tick has no time left; the detach is already saved', async () => {
    const h = makeTestDeps()
    const { projectId, subA, subB } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0
    const groups = await h.store.detachExpiredTakeovers(new Date(TEST_NOW.getTime() + 1))
    expect(groups).toHaveLength(2)
    // 15 s left: one card needs two LINE calls of up to 10 s each.
    await announceDetached(h.deps, groups, new Date(h.deps.now().getTime() + 15_000), h.deps.now())
    expect(h.line.pushes).toHaveLength(0)
    for (const sub of [subA, subB]) expect(groupRow(h, sub.id).projectId).toBeNull()
    // With a full tick's time both go out.
    await announceDetached(h.deps, groups, driveDeadline(h.deps.now()), h.deps.now())
    expect(h.line.pushes).toHaveLength(2)
  })
})

describe('a pending Owner while the change is pending', () => {
  it('the main group may name a new Owner who has not confirmed; the confirmed one still answers', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    // The main group names someone else, who has not confirmed (the #30 flow).
    Object.assign(groupRow(h, main.id), { nominatedOwnerLineUserId: PENDING, ownerConfirmedAt: null })

    // The take-over question still waits, and only the Project's owner may answer it.
    expect((await loadTakeover(h.deps, { idToken: `tok-${NEW}`, groupId: main.id })).status).toBe(200)
    expect(await loadTakeover(h.deps, { idToken: `tok-${PENDING}`, groupId: main.id })).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect(await answer(h, main.id, PENDING, 'takeover')).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect(h.store.tables.projects[0].ownerLineUserId).toBe(NEW)

    expect((await answer(h, main.id, NEW, 'takeover')).status).toBe(200)
    for (const sub of [subA, subB]) expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: NEW })
  })

  it('the 7-day rule still runs with a pending Owner named', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    Object.assign(groupRow(h, main.id), { nominatedOwnerLineUserId: PENDING, ownerConfirmedAt: null })
    await tick(h, new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + 15 * MIN))
    expect(groupRow(h, subA.id).projectId).toBeNull()
    expect(groupRow(h, main.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: PENDING })
  })

  it('when the pending Owner confirms, the question starts again for them', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    Object.assign(groupRow(h, main.id), { nominatedOwnerLineUserId: PENDING, ownerConfirmedAt: null })
    const later = new Date(TEST_NOW.getTime() + 2 * 86_400_000)
    h.setNow(later)
    expect(await change(h, projectId, PENDING)).toEqual({ outcome: 'changed', waitingSubGroups: 2, card: 'pushed' })
    expect(h.store.tables.projects[0].ownerLineUserId).toBe(PENDING)
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(later)
    expect(await answer(h, main.id, NEW, 'takeover')).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect((await answer(h, main.id, PENDING, 'takeover')).status).toBe(200)
    expect(groupRow(h, subA.id).nominatedOwnerLineUserId).toBe(PENDING)
  })
})
