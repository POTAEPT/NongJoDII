import { randomUUID } from 'node:crypto'
import { seal } from '@/server/crypto/secretbox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveDeadline } from '@/server/google/drive-folders'
import type { LineMessage } from '@/server/line/types'
import { answerTakeover, loadTakeover } from '@/server/owner-change/answer'
import { OWNER_NEEDED_TEXT, ownerExitJob } from '@/server/members/owner-left'
import { TAKEOVER_CARD_TEXT } from '@/server/owner-change/card'
import { submitSetup } from '@/server/setup/submit'
import { announceDetached, TAKEOVER_WAIT_MS, takeoverExpiryJob } from '@/server/owner-change/detach'
import { takeoverCardRetryJob } from '@/server/owner-change/takeover-retry'
import { applyOwnerChange } from '@/server/setup/owner-change'
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
  // #30: OLD left the main group, which names the new Owner (not confirmed yet).
  const mainRow = store.tables.groups.find((g) => g.id === main.id)!
  Object.assign(mainRow, { nominatedOwnerLineUserId: NEW, ownerConfirmedAt: null, ownerLeftAt: new Date(TEST_NOW) })
  store.pushClock = () => h.deps.now()
  for (const u of [OLD, NEW, PENDING, MEMBER]) h.line.idTokens.set(`tok-${u}`, { lineUserId: u, displayName: null })
  return { projectId, main, subA, subB }
}

const groupRow = (h: H, id: string) => h.store.tables.groups.find((g) => g.id === id)!
const setupRow = (h: H, id: string) => h.store.tables.group_setups.find((r) => r.groupId === id)!
const altTexts = (ms: LineMessage[]) => ms.map((m) => (m.type === 'flex' ? m.altText : m.type === 'text' ? m.text : ''))
const uriOf = (m: LineMessage) => JSON.stringify(m).match(/https:\/\/liff\.line\.me\/[^"]+/)?.[0]

/** The production path (#30 then #31): the main group's Owner left and `who` holds the
 *  nomination with a valid Google sign-in, so applyOwnerChange (what takeOverOwner and the
 *  Google callback run) calls complete_owner_change, then onMainGroupOwnerChanged posts the
 *  take-over card after the response. Answers complete_owner_change's outcome. */
async function change(h: H, projectId: string, who = NEW) {
  const main = h.store.tables.groups.find((g) => g.projectId === projectId && setupRow(h, g.id)?.isMain)!
  // A nominee named after a confirm stands for an Owner who left again.
  if (main.nominatedOwnerLineUserId === who && main.ownerConfirmedAt === null && main.ownerLeftAt === null) {
    main.ownerLeftAt = h.deps.now()
  }
  if (!h.store.tables.google_accounts.some((a) => a.lineUserId === who)) {
    h.store.tables.google_accounts.push({
      id: `ga-${who}`, lineUserId: who, googleSubject: `sub-${who}`, email: null, grantedScopes: [],
      refreshTokenCiphertext: null, tokenStatus: 'valid', updatedAt: h.deps.now(),
    })
  }
  const outcome = await applyOwnerChange(h.deps, main.id, who, h.defer)
  await h.runDeferred()
  return outcome
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

describe('the Owner change (#31 step 1, after the new Owner confirms for the main group)', () => {
  it('makes the new Owner the Project owner, pauses the Sub groups and posts one question card in the main group', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    expect(await change(h, projectId)).toBe('changed')

    expect(h.store.tables.projects[0]).toMatchObject({ ownerLineUserId: NEW, driveProjectFolderId: null })
    expect(groupRow(h, main.id)).toMatchObject({ nominatedOwnerLineUserId: NEW, ownerConfirmedAt: TEST_NOW })
    expect(setupRow(h, main.id).driveFolderId).toBeNull()
    for (const sub of [subA, subB]) {
      // Paused: no confirmed Owner, still naming the old one. The folder ID is cleared: it
      // points into the old Owner's Drive (#74-4).
      expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: null })
      expect(setupRow(h, sub.id).takeoverAskedAt).toEqual(TEST_NOW)
      expect(setupRow(h, sub.id).driveFolderId).toBeNull()
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
    expect(await change(h, projectId)).toBe('already_owner')
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(TEST_NOW)
    expect(h.line.pushes).toHaveLength(1)
  })

  it('someone the main group does not name changes nothing', async () => {
    const h = makeTestDeps()
    const { projectId, subA } = seedProject(h)
    const before = structuredClone(h.store.tables)
    expect(await change(h, projectId, MEMBER)).toBe('not_nominee')
    expect(h.store.tables.groups).toEqual(before.groups)
    expect(h.store.tables.projects).toEqual(before.projects)
    expect(setupRow(h, subA.id).takeoverAskedAt ?? null).toBeNull()
    expect(h.line.pushes).toHaveLength(0)
  })

  it('a Project with no Sub groups posts no card', async () => {
    const h = makeTestDeps()
    const { projectId, subA, subB } = seedProject(h)
    for (const s of [subA, subB]) groupRow(h, s.id).projectId = null
    expect(await change(h, projectId)).toBe('changed')
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
    expect(setupRow(h, subA.id).driveFolderId).toBeNull()
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

  it('detach: the Sub groups leave the Project with no nominee (any Member may claim) and each gets the owner_needed card (#30 part B)', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0
    const res = await answer(h, main.id, NEW, 'detach')
    expect(res).toEqual({ status: 200, body: { choice: 'detach', subGroups: 2 } })
    for (const sub of [subA, subB]) {
      // The old nominee is cleared in the detach itself (user decision 2026-11-16).
      expect(groupRow(h, sub.id)).toMatchObject({ projectId: null, nominatedOwnerLineUserId: null, ownerConfirmedAt: null })
      expect(setupRow(h, sub.id)).toMatchObject({ takeoverAskedAt: null, ownerNominatedByLineUserId: null, ownerNominatedAt: null })
      expect(setupRow(h, sub.id).driveFolderId).toBeNull() // pointed into the old Owner's Drive
    }
    for (const sub of [subA, subB]) expect(groupRow(h, sub.id).ownerLeftAt).toEqual(TEST_NOW) // a fresh 7-day count
    // The cards name nobody.
    expect(h.store.tables.owner_prompts.filter((p) => [subA.id, subB.id].includes(p.groupId)).map((p) => p.subjectLineUserId))
      .toEqual([null, null])
    expect(h.line.pushes.map((p) => p.to).sort()).toEqual(['CsubA', 'CsubB'])
    for (const p of h.line.pushes) {
      const sub = p.to === 'CsubA' ? subA : subB
      expect(altTexts(p.messages)[0]).toContain(OWNER_NEEDED_TEXT.title)
      expect(uriOf(p.messages[0])).toBe(`https://liff.line.me/2000000000-abcdefgh?view=owner&id=${sub.id}`)
    }
    expect(h.store.tables.push_log.filter((p) => p.purpose === 'owner_needed')).toHaveLength(2)
    // They need a new Owner: a Summary request there answers with the owner_needed card.
    expect((await summarize(h, 'CsubA')).some((t) => t.includes(OWNER_NEEDED_TEXT.title))).toBe(true)
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
      expect(setupRow(h, sub.id).driveFolderId).toBeNull()
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
    expect(await change(h, projectId, PENDING)).toBe('changed')
    expect(h.line.pushes.filter((p) => p.to === 'Cmain')).toHaveLength(2) // a new question card
    expect(h.store.tables.projects[0].ownerLineUserId).toBe(PENDING)
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(later)
    expect(await answer(h, main.id, NEW, 'takeover')).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect((await answer(h, main.id, PENDING, 'takeover')).status).toBe(200)
    expect(groupRow(h, subA.id).nominatedOwnerLineUserId).toBe(PENDING)
  })
})

describe('review follow-ups (#72)', () => {
  it('a plain Member is refused: 403 not_owner, nothing written', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    expect(await answer(h, main.id, MEMBER, 'detach')).toEqual({ status: 403, body: { error: 'not_owner' } })
    expect(groupRow(h, subA.id).projectId).toBe(projectId)
    expect(setupRow(h, subA.id).takeoverAskedAt).toEqual(TEST_NOW)
  })

  it('an answer after day 7, before the tick detached them, is refused: 409 expired, nothing written', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    h.setNow(new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + MIN))
    expect(await answer(h, main.id, NEW, 'takeover')).toEqual({ status: 409, body: { error: 'expired' } })
    expect(groupRow(h, subA.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: OLD, ownerConfirmedAt: null })
    // The store refuses it too (the SQL guard in answer_subgroup_takeover).
    expect(await h.store.answerSubgroupTakeover(projectId, [subA.id])).toEqual({ outcome: 'expired' })
    // The tick then detaches them as usual.
    await tick(h, new Date(TEST_NOW.getTime() + TAKEOVER_WAIT_MS + 15 * MIN))
    expect(groupRow(h, subA.id).projectId).toBeNull()
  })

  it('D1: an Owner change keeps Sub groups already taken over by that person running', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    await answer(h, main.id, NEW, 'takeover')
    const takenAt = h.deps.now()
    setupRow(h, subA.id).driveFolderId = 'fold-new-A'
    // NEW leaves the main group and comes back; the role goes through the change again.
    Object.assign(groupRow(h, main.id), { ownerConfirmedAt: null, ownerLeftAt: new Date(TEST_NOW.getTime() + MIN) })
    h.setNow(new Date(TEST_NOW.getTime() + 86_400_000))
    const cards = h.line.pushes.length
    expect(await change(h, projectId)).toBe('changed')
    for (const sub of [subA, subB]) {
      expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: NEW, ownerConfirmedAt: takenAt })
      expect(setupRow(h, sub.id).takeoverAskedAt ?? null).toBeNull()
    }
    expect(setupRow(h, subA.id).driveFolderId).toBe('fold-new-A')
    expect(h.line.pushes).toHaveLength(cards) // nothing to ask
  })

  it('D1: a change to someone else asks the waiting Sub groups again, and must ask the taken-over ones too (same-Owner rule)', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA, subB } = seedProject(h)
    await change(h, projectId)
    await answer(h, main.id, NEW, 'takeover')
    // NEW leaves; PENDING claims and confirms.
    Object.assign(groupRow(h, main.id), { nominatedOwnerLineUserId: PENDING, ownerConfirmedAt: null, ownerLeftAt: new Date(TEST_NOW) })
    const later = new Date(TEST_NOW.getTime() + 86_400_000)
    h.setNow(later)
    expect(await change(h, projectId, PENDING)).toBe('changed')
    for (const sub of [subA, subB]) {
      // A Sub group cannot keep NEW while the Project is PENDING's: it waits for PENDING's answer.
      expect(groupRow(h, sub.id)).toMatchObject({ projectId, nominatedOwnerLineUserId: NEW, ownerConfirmedAt: null })
      expect(setupRow(h, sub.id)).toMatchObject({ takeoverAskedAt: later, driveFolderId: null })
    }
  })

  it('a take-over card skipped near the quota is posted by a later tick, once', async () => {
    const h = makeTestDeps()
    const { projectId } = seedProject(h)
    h.line.quota = { limit: 10, used: 10 }
    await change(h, projectId)
    expect(h.line.delivered).toHaveLength(0)
    const retry = async (at: Date) => {
      h.setNow(at)
      expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [takeoverCardRetryJob])).status).toBe(200)
      await h.runDeferred()
    }
    await retry(new Date(TEST_NOW.getTime() + 15 * MIN)) // first retry tick: still no quota
    expect(h.line.delivered).toHaveLength(0)
    h.line.quota = { limit: null, used: 0 }
    await retry(new Date(TEST_NOW.getTime() + 30 * MIN)) // not a retry tick
    expect(h.line.delivered).toHaveLength(0)
    await retry(new Date(TEST_NOW.getTime() + 120 * MIN)) // second retry tick
    expect(h.line.delivered.map((p) => p.to)).toEqual(['Cmain'])
    expect(altTexts(h.line.delivered[0].messages)[0]).toContain(TAKEOVER_CARD_TEXT.paused(2))
    await retry(new Date(TEST_NOW.getTime() + 24 * 60 * MIN)) // third retry tick: already sent
    await retry(new Date(TEST_NOW.getTime() + 2 * 86_400_000))
    // Skipped tries never reached LINE; the dedupe keeps it to one card.
    expect(h.line.pushes.filter((p) => p.to === 'Cmain')).toHaveLength(1)
  })

  it('a take-over card that failed (LINE refused it) is posted by a later tick; the tick job is in the tick', async () => {
    const h = makeTestDeps()
    const { projectId } = seedProject(h)
    h.line.rejectPush = true
    await change(h, projectId)
    expect(h.line.delivered).toHaveLength(0)
    h.line.rejectPush = false
    h.setNow(new Date(TEST_NOW.getTime() + 15 * MIN))
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [takeoverCardRetryJob])).status).toBe(200)
    await h.runDeferred()
    expect(h.line.delivered.map((p) => p.to)).toEqual(['Cmain'])
    expect(TICK_JOBS.map((j) => j.name)).toContain(takeoverCardRetryJob.name)
  })
})

describe('a manual "detach" answer (#30 part B): the owner_needed flow, as for every detach', () => {
  const DAY = 86_400_000
  const form = (groupId: string, who: string) => ({
    idToken: `tok-${who}`, groupId, workDescription: 'งาน',
    features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
    members: [{ lineUserId: who, nicknames: [], role: '' }], ownerLineUserId: who,
  })

  it('sets owner_left_at, posts one card, and the setup form then needs Drive', async () => {
    const h = makeTestDeps()
    h.store.pushClock = () => h.deps.now()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0
    await answer(h, main.id, NEW, 'detach')
    expect(groupRow(h, subA.id)).toMatchObject({ projectId: null, ownerConfirmedAt: null, ownerLeftAt: TEST_NOW })
    expect(h.line.pushes.filter((p) => p.to === 'CsubA')).toHaveLength(1)
    // The old Owner, still its nominee, has left it; a Member names themselves in the setup
    // form: no confirm without Drive.
    await h.store.markMemberLeft({ groupId: subA.id, lineUserId: OLD, at: TEST_NOW })
    const res = await submitSetup(h.deps, form(subA.id, MEMBER), h.defer)
    await h.runDeferred()
    expect(res).toEqual({ status: 200, body: { state: 'needs_drive' } })
    expect(groupRow(h, subA.id)).toMatchObject({ nominatedOwnerLineUserId: MEMBER, ownerConfirmedAt: null, projectId: null })
  })

  it('a repeated answer posts no second card', async () => {
    const h = makeTestDeps()
    const { projectId, main } = seedProject(h)
    await change(h, projectId)
    h.line.pushes.length = 0
    await answer(h, main.id, NEW, 'detach')
    expect(await answer(h, main.id, NEW, 'detach')).toEqual({ status: 409, body: { error: 'nothing_waiting' } })
    expect(h.line.pushes).toHaveLength(2) // one per Sub group, from the first answer
    // The store step itself is idempotent too.
    expect(await h.store.startDetachedOwnerCount([main.id], TEST_NOW)).toEqual([])
  })

  it('with no new Owner 7 days later, the bot leaves', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    await answer(h, main.id, NEW, 'detach')
    const run = async (at: Date) => {
      h.setNow(at)
      expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [ownerExitJob])).status).toBe(200)
      await h.runDeferred()
    }
    await run(new Date(TEST_NOW.getTime() + 7 * DAY - 15 * MIN))
    expect(h.line.leaveCalls).toEqual([])
    await run(new Date(TEST_NOW.getTime() + 7 * DAY))
    expect(new Set(h.line.leaveCalls)).toEqual(new Set(['CsubA', 'CsubB']))
    expect(h.store.tables.group_schedules.find((r) => r.groupId === subA.id)?.leftAt).toEqual(new Date(TEST_NOW.getTime() + 7 * DAY))
  })
})

describe('a manual detach clears the nominee: any live Member can claim (user decision 2026-11-16)', () => {
  it('a Member who is not the old Owner claims the detached group at once', async () => {
    const h = makeTestDeps()
    const { projectId, main, subA } = seedProject(h)
    await change(h, projectId)
    await answer(h, main.id, NEW, 'detach')
    // OLD is still a live Member of the Sub group, but no longer its nominee.
    expect((await h.store.claimOwnerChange(subA.id, MEMBER, h.deps.now())).outcome).toBe('claimed')
    expect(groupRow(h, subA.id)).toMatchObject({ nominatedOwnerLineUserId: MEMBER, ownerConfirmedAt: null })
  })
})

describe('take-over card retry: what it does not cover', () => {
  it('a push whose outcome is unknown (LINE 5xx or timeout) keeps its budget claim and is not retried', async () => {
    const h = makeTestDeps()
    const { projectId } = seedProject(h)
    h.line.failPush = true
    await change(h, projectId)
    h.line.failPush = false
    h.setNow(new Date(TEST_NOW.getTime() + 15 * MIN))
    expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [takeoverCardRetryJob])).status).toBe(200)
    await h.runDeferred()
    // LINE may have delivered it, so the claim stands for it: no second push.
    expect(h.line.pushes.filter((p) => p.to === 'Cmain')).toHaveLength(1)
  })
})

describe('take-over card retry: a card LINE keeps refusing', () => {
  it('a 4xx is tried three more times (15 min, 2 h, 24 h after the ask), not every tick', async () => {
    const h = makeTestDeps()
    const { projectId } = seedProject(h)
    h.line.rejectPush = true
    await change(h, projectId)
    for (let t = 15 * MIN; t <= 3 * 86_400_000; t += 15 * MIN) {
      h.setNow(new Date(TEST_NOW.getTime() + t))
      expect((await handleTickRequest(tickRequest(), h.deps, h.defer, [takeoverCardRetryJob])).status).toBe(200)
      await h.runDeferred()
    }
    expect(h.line.pushes.filter((p) => p.to === 'Cmain')).toHaveLength(1 + 3)
    expect(h.line.delivered).toHaveLength(0)
  })
})
