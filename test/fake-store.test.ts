import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { NewMessage } from '@/server/ports'
import { FakeStore } from './fakes/fake-store'
import { FakeLine } from './fakes/fake-line'
import { FakeLlm } from './fakes/fake-llm'
import { FakeGoogle } from './fakes/fake-google'
import { TEST_KEY, TEST_LIFF_ID, TEST_SECRET, TEST_TICK_SECRET, ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

const SENT_AT = new Date('2026-11-12T02:00:00Z')

async function storeWithGroup() {
  const store = new FakeStore()
  const group = await store.ensureGroup('Cgroup1')
  await store.upsertLineUser({ lineUserId: 'Uuser1', displayName: 'Ploy' })
  return { store, group }
}

async function recordEvent(store: FakeStore, webhookEventId: string) {
  await store.recordWebhookEvent({
    webhookEventId,
    eventType: 'message',
    lineGroupId: 'Cgroup1',
    eventTimestamp: SENT_AT,
    isRedelivery: false,
  })
}

function message(groupId: string, webhookEventId: string, lineMessageId: string): NewMessage {
  return {
    groupId,
    webhookEventId,
    lineMessageId,
    senderLineUserId: 'Uuser1',
    messageType: 'text',
    text: 'hello',
    sentAt: SENT_AT,
    imageSetId: null,
    imageSetIndex: null,
    imageSetTotal: null,
    mentions: null,
  }
}

describe('FakeStore', () => {
  test('recordWebhookEvent stores an ID once', async () => {
    const store = new FakeStore()
    const e = {
      webhookEventId: 'ev-1',
      eventType: 'message',
      lineGroupId: null,
      eventTimestamp: SENT_AT,
      isRedelivery: false,
    }
    expect(await store.recordWebhookEvent(e)).toEqual({ inserted: true })
    expect(await store.recordWebhookEvent({ ...e, isRedelivery: true })).toEqual({ inserted: false })
    expect(store.tables.webhook_events).toHaveLength(1)
    expect(store.tables.webhook_events[0].isRedelivery).toBe(false)
  })

  test('insertMessage ignores a redelivered webhookEventId', async () => {
    const { store, group } = await storeWithGroup()
    await recordEvent(store, 'ev-1')
    const first = await store.insertMessage(message(group.id, 'ev-1', 'm-1'))
    expect(first.inserted).toBe(true)
    expect(first.id).toEqual(expect.any(String))
    expect(await store.insertMessage(message(group.id, 'ev-1', 'm-1'))).toEqual({ inserted: false, id: null })
    expect(store.tables.messages).toHaveLength(1)
  })

  test('insertMessage with a new webhookEventId but a known lineMessageId throws', async () => {
    const { store, group } = await storeWithGroup()
    await recordEvent(store, 'ev-1')
    await recordEvent(store, 'ev-2')
    await store.insertMessage(message(group.id, 'ev-1', 'm-1'))
    await expect(store.insertMessage(message(group.id, 'ev-2', 'm-1'))).rejects.toThrow(
      'unique violation: messages.line_message_id',
    )
    expect(store.tables.messages).toHaveLength(1)
  })

  test('insertMessage for an unknown group is an FK violation', async () => {
    const { store } = await storeWithGroup()
    await recordEvent(store, 'ev-1')
    await expect(store.insertMessage(message('no-such-group', 'ev-1', 'm-1'))).rejects.toThrow(
      'FK violation: messages.group_id',
    )
    expect(store.tables.messages).toHaveLength(0)
  })

  test('insertMessage needs the webhook event and a known sender', async () => {
    const { store, group } = await storeWithGroup()
    await expect(store.insertMessage(message(group.id, 'ev-x', 'm-1'))).rejects.toThrow(
      'FK violation: messages.webhook_event_id',
    )
    await recordEvent(store, 'ev-1')
    await expect(
      store.insertMessage({ ...message(group.id, 'ev-1', 'm-1'), senderLineUserId: 'Unknown' }),
    ).rejects.toThrow('FK violation: messages.sender_line_user_id')
  })

  test('confirmCandidate twice for one candidate returns the same Task', async () => {
    const store = new FakeStore()
    const group = await store.ensureGroup('Cgroup1')
    await store.upsertLineUser({ lineUserId: 'Uowner1', displayName: 'Owner' })
    const { candidateIds } = await store.createSummary(
      {
        groupId: group.id,
        requestedByLineUserId: 'Uowner1',
        summaryText: 's',
        firstMessageAt: null,
        lastMessageAt: null,
        createdAt: SENT_AT,
      },
      [{ title: 't', details: null, suggestedAssigneeLineUserId: null, suggestedDueAt: null }],
    )
    const task = {
      groupId: group.id,
      candidateId: candidateIds[0],
      title: 't',
      details: null,
      status: 'not_assigned' as const,
      assigneeLineUserId: null,
      createdByLineUserId: 'Uowner1',
      dueAt: null,
    }
    const first = await store.confirmCandidate(task, SENT_AT)
    expect(first.outcome).toBe('created')
    expect(store.tables.task_candidates[0]).toMatchObject({ state: 'confirmed', decidedByLineUserId: 'Uowner1' })
    const second = await store.confirmCandidate({ ...task, title: 'other' }, SENT_AT)
    expect(second).toEqual({ outcome: 'already_decided', taskId: first.taskId })
    expect(store.tables.tasks).toHaveLength(1)
    expect((await store.getTask(first.taskId!))?.title).toBe('t')
  })

  test('confirmCandidate on a declined candidate creates no Task', async () => {
    const store = new FakeStore()
    const group = await store.ensureGroup('Cgroup1')
    await store.upsertLineUser({ lineUserId: 'Uowner1', displayName: 'Owner' })
    const { candidateIds } = await store.createSummary(
      { groupId: group.id, requestedByLineUserId: null, summaryText: 's', firstMessageAt: null, lastMessageAt: null, createdAt: SENT_AT },
      [{ title: 't', details: null, suggestedAssigneeLineUserId: null, suggestedDueAt: null }],
    )
    await store.decideCandidate(candidateIds[0], 'declined', 'Uowner1', SENT_AT)
    const res = await store.confirmCandidate({
      groupId: group.id, candidateId: candidateIds[0], title: 't', details: null, status: 'not_assigned',
      assigneeLineUserId: null, createdByLineUserId: 'Uowner1', dueAt: null,
    }, SENT_AT)
    expect(res).toEqual({ outcome: 'already_decided', taskId: null })
    expect(store.tables.tasks).toHaveLength(0)
    expect(store.tables.task_candidates[0].state).toBe('declined')
  })

  test('decideCandidate only moves a proposed candidate', async () => {
    const store = new FakeStore()
    const group = await store.ensureGroup('Cgroup1')
    await store.upsertLineUser({ lineUserId: 'Uowner1', displayName: 'Owner' })
    const { candidateIds } = await store.createSummary(
      {
        groupId: group.id,
        requestedByLineUserId: null,
        summaryText: 's',
        firstMessageAt: null,
        lastMessageAt: null,
        createdAt: SENT_AT,
      },
      [{ title: 't', details: null, suggestedAssigneeLineUserId: null, suggestedDueAt: null }],
    )
    expect(await store.decideCandidate(candidateIds[0], 'confirmed', 'Uowner1', SENT_AT)).toEqual({ updated: true })
    expect(await store.decideCandidate(candidateIds[0], 'declined', 'Uowner1', SENT_AT)).toEqual({ updated: false })
    expect(store.tables.task_candidates[0].state).toBe('confirmed')
  })

  test('claimFairUseNotice claims one key once', async () => {
    const store = new FakeStore()
    const n = { ownerLineUserId: 'Uowner1', groupId: 'g1', monthStartBkk: '2026-11-01', kind: 'warn_80' as const }
    expect(await store.claimFairUseNotice(n)).toEqual({ inserted: true })
    expect(await store.claimFairUseNotice(n)).toEqual({ inserted: false })
    expect(await store.claimFairUseNotice({ ...n, monthStartBkk: '2026-12-01' })).toEqual({ inserted: true })
  })

  test('createSummary keeps candidate order, 1 ms apart', async () => {
    const store = new FakeStore()
    const group = await store.ensureGroup('Cgroup1')
    const created = await store.createSummary(
      {
        groupId: group.id,
        requestedByLineUserId: null,
        summaryText: 's',
        firstMessageAt: null,
        lastMessageAt: null,
        createdAt: SENT_AT,
      },
      ['a', 'b', 'c'].map((title) => ({
        title,
        details: null,
        suggestedAssigneeLineUserId: null,
        suggestedDueAt: null,
      })),
    )
    const listed = await store.listCandidates(created.summaryId)
    expect(listed.map((c) => c.title)).toEqual(['a', 'b', 'c'])
    expect(listed.map((c) => c.id)).toEqual(created.candidateIds)
    expect(listed.every((c) => c.state === 'proposed' && c.summaryId === created.summaryId)).toBe(true)
    const times = store.tables.task_candidates.map((c) => c.createdAt.getTime())
    expect(times).toEqual([SENT_AT.getTime(), SENT_AT.getTime() + 1, SENT_AT.getTime() + 2])
  })

  test('failNext with after: 1 fails only the second call', async () => {
    const { store, group } = await storeWithGroup()
    for (const id of ['ev-1', 'ev-2', 'ev-3']) await recordEvent(store, id)
    store.failNext('insertMessage', undefined, { after: 1 })
    await expect(store.insertMessage(message(group.id, 'ev-1', 'm-1'))).resolves.toMatchObject({ inserted: true })
    await expect(store.insertMessage(message(group.id, 'ev-2', 'm-2'))).rejects.toThrow()
    await expect(store.insertMessage(message(group.id, 'ev-3', 'm-3'))).resolves.toMatchObject({ inserted: true })
    expect(store.tables.messages.map((m) => m.lineMessageId)).toEqual(['m-1', 'm-3'])
  })

  test('failNext rejects with the given error', async () => {
    const store = new FakeStore()
    const err = new Error('boom')
    store.failNext('ensureGroup', err)
    await expect(store.ensureGroup('Cgroup1')).rejects.toBe(err)
    expect(store.tables.groups).toHaveLength(0)
  })

  test('seedTask returns a row that getTask finds', async () => {
    const store = new FakeStore()
    const group = store.seedGroup({ lineGroupId: 'Cgroup1' })
    const seeded = store.seedTask({ groupId: group.id, title: 'Done one', createdByLineUserId: 'Uowner1', status: 'done' })
    expect(seeded).toMatchObject({ status: 'done', candidateId: null, deletedAt: null, lineGroupId: 'Cgroup1' })
    expect(await store.getTask(seeded.id)).toEqual(seeded)
    // candidate_id is unique but nullable: two Tasks without a candidate do not clash.
    store.seedTask({ groupId: group.id, title: 'Two', createdByLineUserId: 'Uowner1' })
    expect(store.tables.tasks).toHaveLength(2)
  })

  test('confirmProgressYes from someone who is neither assignee nor subject is task_changed and writes nothing', async () => {
    const store = new FakeStore()
    const group = store.seedGroup({ lineGroupId: 'Cgroup1' })
    for (const id of ['Uowner1', 'Uassignee', 'Usubject', 'Uother']) store.seedMember({ groupId: group.id, lineUserId: id, displayName: id })
    const task = store.seedTask({
      groupId: group.id, title: 'T', createdByLineUserId: 'Uowner1', status: 'in_process', assigneeLineUserId: 'Uassignee',
    })
    const { prompt } = await store.createProgressPrompt({
      groupId: group.id, taskId: task.id, targetStatus: 'done', subjectLineUserId: 'Usubject', triggerMessageId: null, askedAt: SENT_AT,
    })
    const yes = (by: string) => ({
      promptId: prompt!.id, taskId: task.id, fromStatus: 'in_process' as const, toStatus: 'done' as const,
      byLineUserId: by, assignTo: null, at: SENT_AT,
    })
    expect(await store.confirmProgressYes(yes('Uother'))).toEqual({ outcome: 'task_changed' })
    expect(store.tables.tasks[0]).toMatchObject({ status: 'in_process', doneAt: null, assigneeLineUserId: 'Uassignee' })
    expect(store.tables.task_prompts[0].answer).toBeNull()
    expect(await store.confirmProgressYes(yes('Usubject'))).toEqual({ outcome: 'updated' })
  })

  test('sumOwnerMonthUsage buckets by Bangkok month', async () => {
    const store = new FakeStore()
    store.seedAiUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.000123, createdAt: new Date('2026-11-01T00:00:00Z') })
    store.seedAiUsage({ inputTokens: 10, outputTokens: 5, costUsd: 0.000001, createdAt: new Date('2026-11-30T16:59:59Z') })
    // 2026-11-30T17:00:00Z is 2026-12-01 00:00 in Bangkok.
    store.seedAiUsage({ inputTokens: 7, outputTokens: 3, costUsd: 0.5, createdAt: new Date('2026-11-30T17:00:00Z') })
    store.seedAiUsage({ ownerLineUserId: 'Uother', inputTokens: 999, outputTokens: 1, costUsd: 1 })
    expect(await store.sumOwnerMonthUsage('Uowner1', '2026-11-01')).toEqual({ tokens: 165, costMicroUsd: 124 })
    expect(await store.sumOwnerMonthUsage('Uowner1', '2026-12-01')).toEqual({ tokens: 10, costMicroUsd: 500000 })
    expect(await store.sumOwnerMonthUsage('Uowner1', '2026-10-01')).toEqual({ tokens: 0, costMicroUsd: 0 })
  })

  test('null-name upsertLineUser never overwrites a known name', async () => {
    const store = new FakeStore()
    await store.upsertLineUser({ lineUserId: 'U1', displayName: 'Ploy' })
    await store.upsertLineUser({ lineUserId: 'U1', displayName: null })
    expect(await store.findLineUser('U1')).toEqual({ lineUserId: 'U1', displayName: 'Ploy' })
    await store.upsertLineUser({ lineUserId: 'U1', displayName: 'Ploy 2' })
    expect(await store.findLineUser('U1')).toEqual({ lineUserId: 'U1', displayName: 'Ploy 2' })
  })

  test('ensureGroup and touchGroupMember insert once', async () => {
    const store = new FakeStore()
    const a = await store.ensureGroup('Cgroup1')
    const b = await store.ensureGroup('Cgroup1')
    expect(b).toEqual(a)
    expect(a).toMatchObject({ featureSummarize: true, featureDraftTasks: true, nominatedOwnerLineUserId: null, ownerConfirmedAt: null })
    await expect(store.touchGroupMember(a.id, 'Unknown', 'message')).rejects.toThrow('FK violation: group_members.line_user_id')
    await store.upsertLineUser({ lineUserId: 'U1', displayName: null })
    await store.touchGroupMember(a.id, 'U1', 'message')
    await store.touchGroupMember(a.id, 'U1', 'liff')
    expect(store.tables.group_members).toHaveLength(1)
    expect(store.tables.group_members[0].source).toBe('message')
    expect(await store.getMembership(a.id, 'U1')).toBe('live')
    expect(await store.getMembership(a.id, 'U2')).toBe('none')
  })

  test('seedMember with leftAt makes a left Member, not listed live', async () => {
    const store = new FakeStore()
    const group = store.seedGroup({ lineGroupId: 'Cgroup1' })
    store.seedMember({ groupId: group.id, lineUserId: 'U1', displayName: 'Ploy', nicknames: ['พลอย'], role: 'design' })
    store.seedMember({ groupId: group.id, lineUserId: 'U2', displayName: 'Ton', leftAt: SENT_AT })
    expect(await store.getMembership(group.id, 'U2')).toBe('left')
    expect(await store.listLiveMembers(group.id)).toEqual([
      { lineUserId: 'U1', displayName: 'Ploy', nicknames: ['พลอย'], role: 'design' },
    ])
  })

  test('listRecentTextMessages returns the newest text messages oldest first', async () => {
    const { store, group } = await storeWithGroup()
    for (let i = 1; i <= 4; i++) {
      await recordEvent(store, `ev-${i}`)
      await store.insertMessage({
        ...message(group.id, `ev-${i}`, `m-${i}`),
        text: `t${i}`,
        sentAt: new Date(SENT_AT.getTime() + i * 1000),
      })
    }
    await recordEvent(store, 'ev-img')
    await store.insertMessage({
      ...message(group.id, 'ev-img', 'm-img'),
      messageType: 'image',
      text: null,
      sentAt: new Date(SENT_AT.getTime() + 9000),
    })
    const listed = await store.listRecentTextMessages(group.id, 3)
    expect(listed.map((m) => m.text)).toEqual(['t2', 't3', 't4'])
    expect(listed[0].senderDisplayName).toBe('Ploy')
  })

  test('upsertGoogleAccount updates on the same Google subject', async () => {
    const store = new FakeStore()
    await expect(
      store.upsertGoogleAccount({ lineUserId: 'U1', googleSubject: 'g1', email: null, grantedScopes: [], refreshTokenCiphertext: 'v1.a' }),
    ).rejects.toThrow('FK violation: google_accounts.line_user_id')
    await store.upsertLineUser({ lineUserId: 'U1', displayName: null })
    await store.upsertGoogleAccount({ lineUserId: 'U1', googleSubject: 'g1', email: null, grantedScopes: [], refreshTokenCiphertext: 'v1.a' })
    store.tables.google_accounts[0].tokenStatus = 'revoked'
    await store.upsertGoogleAccount({ lineUserId: 'U1', googleSubject: 'g1', email: 'e@x', grantedScopes: ['openid'], refreshTokenCiphertext: 'v1.b' })
    expect(store.tables.google_accounts).toHaveLength(1)
    expect(store.tables.google_accounts[0]).toMatchObject({ email: 'e@x', refreshTokenCiphertext: 'v1.b', tokenStatus: 'valid' })
    expect(await store.findGoogleAccountByLineUser('U1')).toEqual({ id: store.tables.google_accounts[0].id, tokenStatus: 'valid' })
    expect(await store.findGoogleAccountByLineUser('U2')).toBeNull()
  })
})

describe('makeTestDeps', () => {
  test('wires four fakes plus the store into deps', () => {
    const t = makeTestDeps()
    expect(t.line).toBeInstanceOf(FakeLine)
    expect(t.llm).toBeInstanceOf(FakeLlm)
    expect(t.google).toBeInstanceOf(FakeGoogle)
    expect(t.store).toBeInstanceOf(FakeStore)
    expect(t.deps.line).toBe(t.line)
    expect(t.deps.llm).toBe(t.llm)
    expect(t.deps.google).toBe(t.google)
    expect(t.deps.store).toBe(t.store)
    expect(t.deps.now()).toEqual(new Date('2026-11-12T03:00:00Z'))
    expect(t.deps.config).toEqual({
      lineChannelSecret: TEST_SECRET, liffId: TEST_LIFF_ID, tokenEncryptionKey: TEST_KEY, tickSecret: TEST_TICK_SECRET,
    })
    t.setNow(new Date('2026-12-01T00:00:00Z'))
    expect(t.deps.now()).toEqual(new Date('2026-12-01T00:00:00Z'))
  })

  test('defer collects jobs until runDeferred', async () => {
    const t = makeTestDeps()
    const ran: string[] = []
    t.defer(async () => {
      ran.push('a')
      t.defer(async () => {
        ran.push('b')
      })
    })
    expect(ran).toEqual([])
    expect(t.deferred).toHaveLength(1)
    await t.runDeferred()
    expect(ran).toEqual(['a', 'b'])
  })

  test('seedOwnedGroup makes a confirmed Owner and live Members', async () => {
    const t = makeTestDeps()
    const group = seedOwnedGroup(t.store, { members: [{ lineUserId: 'U1', displayName: 'Ploy' }] })
    expect(group).toMatchObject({ lineGroupId: 'Cgroup1', nominatedOwnerLineUserId: 'Uowner1' })
    expect(group.ownerConfirmedAt).toEqual(new Date('2026-11-12T03:00:00Z'))
    expect(group.projectId).toEqual(expect.any(String))
    const live = await t.store.listLiveMembers(group.id)
    expect(live.map((m) => m.lineUserId).sort()).toEqual(['U1', 'Uowner1'])
  })
})

describe('request and event builders', () => {
  test('signedRequest signs the body with the test secret', async () => {
    const body = webhookBody(ev.groupText({ text: 'hi' }))
    const req = signedRequest(body)
    expect(req.method).toBe('POST')
    expect(req.url).toBe('http://test/api/line/webhook')
    expect(req.headers.get('x-line-signature')).toBe(createHmac('sha256', TEST_SECRET).update(body).digest('base64'))
    expect(await req.text()).toBe(body)
    expect(signedRequest(body, { signature: null }).headers.has('x-line-signature')).toBe(false)
    expect(signedRequest(body, { signature: 'bad' }).headers.get('x-line-signature')).toBe('bad')
  })

  test('event builders use the defaults and unique IDs', () => {
    const a = ev.groupText({ text: 'hi' })
    const b = ev.groupText({ text: 'hi', userId: null })
    expect(a.source).toEqual({ type: 'group', groupId: 'Cgroup1', userId: 'Uuser1' })
    expect(b.source).toEqual({ type: 'group', groupId: 'Cgroup1' })
    expect(a.webhookEventId).not.toBe(b.webhookEventId)
    expect(a.replyToken).not.toBe(b.replyToken)
    expect(a.message?.id).not.toBe(b.message?.id)
    expect(a.timestamp).toBe(Date.parse('2026-11-12T03:00:00Z'))
    expect(JSON.parse(webhookBody(a))).toEqual({ destination: 'Ubot', events: [a] })
    expect(ev.follow({}).type).toBe('follow')
    expect(ev.userText({ text: 'x' }).source).toEqual({ type: 'user', userId: 'Uuser1' })
    expect(ev.groupImage({ imageSet: { id: 's1', index: 1, total: 2 } }).message).toMatchObject({ type: 'image', imageSet: { id: 's1' } })
  })
})
