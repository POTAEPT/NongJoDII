import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seal } from '@/server/crypto/secretbox'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import { BATCH_QUIET_MS, MAX_FILE_BYTES } from '@/server/files/save'
import { driveDeadline, ensureDriveFolders, MAIN_GROUP_FOLDER } from '@/server/google/drive-folders'
import type { LineEvent } from '@/server/line/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, signedRequest, TEST_KEY, TEST_NOW, webhookBody } from './harness'
import { messageText as flexText } from './flex-text'

// #4 acceptance, through the event seam: a file or photo webhook goes in; Drive uploads,
// files rows, replies and pushes come out.

const OWNER = 'Uowner1'
const SENDER = 'Usender1'
const MAIN = 'Cmain'
const SUB = 'Csub'

type H = ReturnType<typeof makeTestDeps>

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

const bytes = (s: string) => new Uint8Array(Buffer.from(s))
const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex')

/** A Project (main group + one Sub group), Owner confirmed, signed in to Google, folders laid out. */
async function setup(): Promise<H & { mainId: string; subId: string; projectId: string }> {
  const h = makeTestDeps()
  const main = h.store.seedGroup({ lineGroupId: MAIN, name: 'ทีมหลัก', nominatedOwnerLineUserId: OWNER })
  h.store.seedMember({ groupId: main.id, lineUserId: OWNER, displayName: 'Owner Name' })
  expect((await h.store.confirmGroupOwner(main.id, OWNER, TEST_NOW)).outcome).toBe('confirmed')
  const projectId = h.store.tables.groups.find((g) => g.id === main.id)!.projectId as string
  const sub = h.store.seedGroup({
    lineGroupId: SUB, name: 'ทีมย่อย', projectId, nominatedOwnerLineUserId: OWNER, ownerConfirmedAt: TEST_NOW,
  })
  h.store.seedMember({ groupId: sub.id, lineUserId: SENDER, displayName: 'Sender Name' })
  h.line.groupMemberCounts.set(MAIN, 3)
  h.line.groupMemberCounts.set(SUB, 3)
  await h.store.upsertGoogleAccount({
    lineUserId: OWNER, googleSubject: 'g-sub-1', email: null,
    grantedScopes: ['https://www.googleapis.com/auth/drive.file'], refreshTokenCiphertext: seal('rt-1', TEST_KEY),
    signedInAt: TEST_NOW,
  })
  await ensureDriveFolders(h.deps, projectId, driveDeadline(h.deps.now()))
  h.google.driveCalls = []
  h.google.refreshCalls = []
  return { ...h, mainId: main.id, subId: sub.id, projectId }
}

async function send(h: H, ...events: LineEvent[]) {
  const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
  expect(res.status).toBe(200)
}

const folderOf = (h: H, groupId: string) => h.store.tables.group_setups.find((r) => r.groupId === groupId)!.driveFolderId
const messageId = (h: H, lineMessageId: string) => h.store.tables.messages.find((m) => m.lineMessageId === lineMessageId)!.id
const cardTexts = (h: H) => [...h.line.replies.flatMap((r) => r.messages), ...h.line.pushes.flatMap((p) => p.messages)].map(flexText)

describe('file saver (#4)', () => {
  it('saves a Sub group file into that Sub group folder and replies with the link', async () => {
    const h = await setup()
    h.line.contents.set('m-file', { data: bytes('report'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, userId: SENDER, messageId: 'm-file', fileName: 'report.pdf', fileSize: 6, replyToken: 'rt-file' }))
    await h.runDeferred()

    expect(h.google.uploads).toHaveLength(1)
    const up = h.google.uploads[0]
    expect(up.parentId).toBe(folderOf(h, h.subId))
    expect(h.google.folders.get(up.parentId)!.name).toBe('ทีมย่อย')
    expect(up).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf' })
    // One refresh for the whole save.
    expect(h.google.refreshCalls).toEqual(['rt-1'])
    // No sharing call for the file: it sits under the Project folder, which is shared
    // "anyone with the link can view", and inherits that, so the link opens without a Google account.
    expect(h.google.driveCalls.filter((c) => c.startsWith('share:'))).toEqual([])
    const projectFolder = h.store.tables.projects.find((p) => p.id === h.projectId)!.driveProjectFolderId!
    expect(h.google.folders.get(up.parentId)!.parentId).toBe(projectFolder)
    expect(h.google.shares).toContainEqual({ fileId: projectFolder, role: 'reader', type: 'anyone' })

    expect(h.line.replies).toHaveLength(1)
    expect(h.line.replies[0].replyToken).toBe('rt-file')
    expect(h.line.pushes).toEqual([])
    expect(flexText(h.line.replies[0].messages[0])).toContain('report.pdf')
    expect(JSON.stringify(h.line.replies[0].messages[0])).toContain(up.webViewLink)
  })

  it('saves a main group photo into "Main group files"', async () => {
    const h = await setup()
    h.line.contents.set('m-img', { data: bytes('jpeg'), contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: MAIN, userId: OWNER, messageId: 'm-img' }))
    await h.runDeferred()
    expect(h.google.uploads).toHaveLength(1)
    expect(h.google.folders.get(h.google.uploads[0].parentId)!.name).toBe(MAIN_GROUP_FOLDER)
    expect(h.google.uploads[0].name).toMatch(/^photo-\d{8}-\d{6}-m-img\.jpg$/)
    expect(h.line.replies).toHaveLength(1)
  })

  it('records name, sender, date, link, size and the Drive connection', async () => {
    const h = await setup()
    h.line.contents.set('m-file', { data: bytes('hello world'), contentType: 'text/plain' })
    await send(h, ev.groupFile({ groupId: SUB, userId: SENDER, messageId: 'm-file', fileName: 'notes.txt', fileSize: 11 }))
    await h.runDeferred()
    const conn = h.store.tables.drive_connections.find((c) => c.projectId === h.projectId && c.status === 'active')!
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.store.tables.files[0]).toMatchObject({
      groupId: h.subId, messageId: messageId(h, 'm-file'), fileName: 'notes.txt', senderLineUserId: SENDER,
      sentAt: TEST_NOW, sizeBytes: 11, driveConnectionId: conn.id, contentSha256: sha('hello world'),
      driveFileId: h.google.uploads[0].id, driveLink: h.google.uploads[0].webViewLink,
    })
  })

  it('a slow save gets the card as a push, counted against the monthly quota', async () => {
    const h = await setup()
    h.line.contents.set('m-big', { data: bytes('big'), contentType: 'video/mp4' })
    h.google.uploadMs = 52_000
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-big', fileName: 'big.mp4', fileSize: 3 }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.line.replies).toEqual([])
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(SUB)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_saved', lineTargetId: SUB })])
  })

  it('a save just inside 50 seconds is still a reply', async () => {
    const h = await setup()
    h.line.contents.set('m-mid', { data: bytes('mid'), contentType: 'application/zip' })
    h.google.uploadMs = 45_000
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-mid', fileName: 'mid.zip', fileSize: 3 }))
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expect(h.line.pushes).toEqual([])
    expect(h.store.tables.push_log).toEqual([])
  })

  it('near the push limit no card is pushed and the file shows on the Dashboard only', async () => {
    const h = await setup()
    h.line.quota = { limit: 300, used: 290 }
    h.line.contents.set('m-big', { data: bytes('big'), contentType: 'application/pdf' })
    h.google.uploadMs = 52_000
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-big', fileName: 'big.pdf', fileSize: 3 }))
    await h.runDeferred()
    expect(h.line.pushes).toEqual([])
    expect(h.line.replies).toEqual([])
    expect(h.store.tables.push_log).toEqual([])
    // The Dashboard read seam, as a Member of the Sub group sees it.
    h.line.idTokens.set('tok-sender', { lineUserId: SENDER, displayName: 'Sender Name' })
    const res = await loadDashboard(h.deps, { idToken: 'tok-sender' })
    expect(res.status).toBe(200)
    const files = (res.body as DashboardData).groups.find((g) => g.groupId === h.subId)!.files
    expect(files).toEqual([expect.objectContaining({
      fileName: 'big.pdf', driveLink: h.google.uploads[0].webViewLink, sizeBytes: 3, senderName: null,
    })])
  })

  it('a save that cannot finish by the hard stop writes nothing and sends nothing', async () => {
    const h = await setup()
    h.line.contents.set('m-huge', { data: bytes('huge'), contentType: 'application/pdf' })
    h.google.uploadMs = 70_000
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-huge', fileName: 'huge.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.google.uploadTimeouts[0]).toBeLessThanOrEqual(55_000)
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies).toEqual([])
    expect(h.line.pushes).toEqual([])
  })

  it('photos of one imageSet arriving out of order, in separate webhooks, get exactly one card', async () => {
    const h = await setup()
    for (const i of [1, 2, 3]) h.line.contents.set(`m-p${i}`, { data: bytes(`photo ${i}`), contentType: 'image/jpeg' })
    // Index 3 first, then 1, then 2; each its own webhook request.
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-p3', imageSet: { id: 'set-A', index: 3, total: 3 } }))
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-p1', imageSet: { id: 'set-A', index: 1, total: 3 } }))
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-p2', imageSet: { id: 'set-A', index: 2, total: 3 } }))
    await h.runDeferred()
    expect(h.google.uploads).toHaveLength(3)
    expect(h.store.tables.files).toHaveLength(3)
    const cards = cardTexts(h)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toContain('3 รูป')
    expect(JSON.stringify(h.line.replies[0].messages[0])).toContain(`folders/${folderOf(h, h.subId)}`)
    expect(h.store.tables.image_set_cards).toEqual([expect.objectContaining({ groupId: h.subId, imageSetId: 'set-A' })])
  })

  it('photos of one imageSet in one webhook, saving at the same time, get exactly one card', async () => {
    const h = await setup()
    for (const i of [1, 2]) h.line.contents.set(`m-q${i}`, { data: bytes(`q ${i}`), contentType: 'image/jpeg' })
    await send(h,
      ev.groupImage({ groupId: SUB, messageId: 'm-q2', imageSet: { id: 'set-B', index: 2, total: 2 } }),
      ev.groupImage({ groupId: SUB, messageId: 'm-q1', imageSet: { id: 'set-B', index: 1, total: 2 } }))
    await h.runDeferred()
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('2 รูป')
  })

  it('a batch without imageSet.total waits, then posts one card with the count', async () => {
    const h = await setup()
    for (const i of [1, 2]) h.line.contents.set(`m-r${i}`, { data: bytes(`r ${i}`), contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-r2', imageSet: { id: 'set-C' } }))
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-r1', imageSet: { id: 'set-C' } }))
    const start = h.deps.now().getTime()
    await h.runDeferred()
    expect(h.deps.now().getTime() - start).toBeGreaterThanOrEqual(BATCH_QUIET_MS)
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('2 รูป')
  })

  it('a batch with a photo still missing posts no card yet', async () => {
    const h = await setup()
    h.line.contents.set('m-s1', { data: bytes('s1'), contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-s1', imageSet: { id: 'set-D', index: 1, total: 2 } }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    expect(cardTexts(h)).toEqual([])
  })

  it('a duplicate (same hash) is saved once; its new message answers a quote-reply', async () => {
    const h = await setup()
    h.line.contents.set('m-a', { data: bytes('same'), contentType: 'application/pdf' })
    h.line.contents.set('m-b', { data: bytes('same'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-a', fileName: 'a.pdf', fileSize: 4 }))
    await h.runDeferred()
    h.google.refreshCalls = []
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-b', fileName: 'b.pdf', fileSize: 4 }))
    await h.runDeferred()

    expect(h.google.uploads).toHaveLength(1)
    expect(h.google.refreshCalls).toEqual([]) // no Google call for a duplicate
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.store.tables.files[0].messageId).toBe(messageId(h, 'm-b'))
    expect(h.line.replies).toHaveLength(2)
    expect(flexText(h.line.replies[1].messages[0])).toContain('เคยบันทึกไว้แล้ว')
    expect(JSON.stringify(h.line.replies[1].messages[0])).toContain(h.google.uploads[0].webViewLink)

    // #33: quoting the re-sent message gives the stored link.
    await send(h, ev.groupText({ groupId: SUB, text: 'NongJoDII ขอไฟล์', quotedMessageId: 'm-b', replyToken: 'rt-ask' }))
    await h.runDeferred()
    const answer = h.line.replies.find((r) => r.replyToken === 'rt-ask')!
    expect(JSON.stringify(answer.messages)).toContain(h.google.uploads[0].webViewLink)
  })

  it('the same content in another group is saved there too', async () => {
    const h = await setup()
    h.line.contents.set('m-a', { data: bytes('same'), contentType: 'application/pdf' })
    h.line.contents.set('m-b', { data: bytes('same'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-a', fileName: 'a.pdf', fileSize: 4 }))
    await send(h, ev.groupFile({ groupId: MAIN, userId: OWNER, messageId: 'm-b', fileName: 'a.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.google.uploads).toHaveLength(2)
    expect(h.store.tables.files).toHaveLength(2)
  })

  it('a revoked token prompts the Owner once, keeps the messages and records no file', async () => {
    const h = await setup()
    h.google.revokedRefreshTokens.add('rt-1')
    for (const i of [1, 2]) h.line.contents.set(`m-v${i}`, { data: bytes(`v ${i}`), contentType: 'image/jpeg' })
    await send(h,
      ev.groupImage({ groupId: SUB, messageId: 'm-v1', imageSet: { id: 'set-V', index: 1, total: 2 } }),
      ev.groupImage({ groupId: SUB, messageId: 'm-v2', imageSet: { id: 'set-V', index: 2, total: 2 } }))
    await h.runDeferred()
    expect(h.store.tables.google_accounts[0].tokenStatus).toBe('revoked')
    expect(h.google.uploads).toEqual([])
    expect(h.store.tables.files).toEqual([])
    expect(h.store.tables.messages.filter((m) => m.lineMessageId.startsWith('m-v'))).toHaveLength(2)
    // The one sign-in card goes to the main group (#14); no saved card anywhere.
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(MAIN)
    expect(h.line.pushes[0].messages[0]).toMatchObject({ type: 'template' })
    expect(h.line.replies).toEqual([])
  })

  it('pauses while the group has no confirmed Owner (the Owner left)', async () => {
    const h = await setup()
    h.store.tables.groups.find((g) => g.id === h.subId)!.ownerConfirmedAt = null
    h.line.contents.set('m-x', { data: bytes('x'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-x', fileName: 'x.pdf', fileSize: 1 }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
    expect(h.store.tables.files).toEqual([])
    expect(h.store.tables.messages.some((m) => m.lineMessageId === 'm-x')).toBe(true)
  })

  it('does nothing when the setup form turned file saving off', async () => {
    const h = await setup()
    h.store.tables.group_setups.find((r) => r.groupId === h.subId)!.featureSaveFiles = false
    h.line.contents.set('m-x', { data: bytes('x'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-x', fileName: 'x.pdf', fileSize: 1 }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
    expect(h.line.replies).toEqual([])
  })

  it('skips a file over the size limit without downloading it', async () => {
    const h = await setup()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-big', fileName: 'big.iso', fileSize: MAX_FILE_BYTES + 1 }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
    expect(h.store.tables.files).toEqual([])
  })

  it('a redelivered file webhook saves once', async () => {
    const h = await setup()
    h.line.contents.set('m-r', { data: bytes('r'), contentType: 'application/pdf' })
    const e = ev.groupFile({ groupId: SUB, messageId: 'm-r', fileName: 'r.pdf', fileSize: 1, eventId: 'ev-r' })
    await send(h, e)
    await send(h, { ...e, deliveryContext: { isRedelivery: true } })
    await h.runDeferred()
    expect(h.google.uploads).toHaveLength(1)
    expect(h.line.replies).toHaveLength(1)
  })

  it('content LINE no longer has is skipped without a card', async () => {
    const h = await setup()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-gone', fileName: 'gone.pdf', fileSize: 1 }))
    await h.runDeferred()
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies).toEqual([])
  })

  it('an external image (no LINE content) is not downloaded', async () => {
    const h = await setup()
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-ext', external: true }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
  })
})
