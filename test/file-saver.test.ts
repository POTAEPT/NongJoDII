import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { seal } from '@/server/crypto/secretbox'
import { SHARE_REFUSED_TEXT } from '@/server/google/share-refused'
import { AdapterError, DriveShareRefused, DriveStorageFull } from '@/server/log'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import { FILE_NOTICE_TEXT, FILE_SAVED_TEXT } from '@/server/files/card'
import { BATCH_QUIET_MS, MAX_FILE_BYTES, POST_SAVE_RESERVE_MS, PUSH_WORST_MS, SAVE_HARD_STOP_MS, SAVING_NOTICE_BYTES } from '@/server/files/save'
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
/** layOut false: the Owner signed in but no folder exists yet (the first save makes them). */
async function setup(opts?: { layOut?: boolean }): Promise<H & { mainId: string; subId: string; projectId: string }> {
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
  if (opts?.layOut !== false) await ensureDriveFolders(h.deps, projectId, driveDeadline(h.deps.now()))
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

  it('a refused share (Workspace policy, 403): one folder kept, one Owner card, files still saved with Owner-only links', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new DriveShareRefused()
    h.line.contents.set('m-s1', { data: bytes('one'), contentType: 'application/pdf' })
    h.line.contents.set('m-s2', { data: bytes('two'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-s1', fileName: 'one.pdf', fileSize: 3 }))
    await h.runDeferred()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-s2', fileName: 'two.pdf', fileSize: 3 }))
    await h.runDeferred()

    // One Project folder, its ID stored though the share failed: no empty folder left behind.
    expect(h.google.foldersNamed('ทีมหลัก')).toHaveLength(1)
    const project = h.store.tables.projects.find((p) => p.id === h.projectId)!
    expect(project.driveProjectFolderId).toBe(h.google.foldersNamed('ทีมหลัก')[0].id)
    expect(h.google.shares).toEqual([])
    // Both files saved, under that folder.
    expect(h.store.tables.files).toHaveLength(2)
    expect(h.google.uploads.map((u) => h.google.folders.get(u.parentId)!.parentId)).toEqual([project.driveProjectFolderId, project.driveProjectFolderId])
    // One Owner card in the main group, though the second save met the refusal again.
    const ownerCards = h.line.pushes.filter((p) => flexText(p.messages[0]).includes(SHARE_REFUSED_TEXT.title))
    expect(ownerCards).toHaveLength(1)
    expect(ownerCards[0].to).toBe(MAIN)
    // The saved cards never say the link opens without a Google account.
    const saved = h.line.replies.map((r) => flexText(r.messages[0]))
    expect(saved).toHaveLength(2)
    for (const t of saved) {
      expect(t).not.toContain('ไม่ต้องมีบัญชี Google')
      expect(t).toContain('เฉพาะเจ้าของ Drive')
    }
  })

  it('a stored Project folder without the link share is shared on the next save once the policy allows it', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new DriveShareRefused()
    h.line.contents.set('m-h1', { data: bytes('h1'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-h1', fileName: 'h1.pdf', fileSize: 2 }))
    await h.runDeferred()
    h.google.shareError = null
    // The refusal is remembered for the Bangkok day: the next day checks again.
    h.setNow(new Date(h.deps.now().getTime() + 24 * 3600_000))
    h.line.contents.set('m-h2', { data: bytes('h2'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-h2', fileName: 'h2.pdf', fileSize: 2 }))
    await h.runDeferred()
    const projectFolder = h.store.tables.projects.find((p) => p.id === h.projectId)!.driveProjectFolderId
    expect(h.google.shares).toEqual([{ fileId: projectFolder, role: 'reader', type: 'anyone' }])
    expect(flexText(h.line.replies[1].messages[0])).toContain('ไม่ต้องมีบัญชี Google')
  })

  it('a share that failed for another reason (5xx) keeps the folder and sends no Owner card', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new AdapterError('google drive share 500')
    h.line.contents.set('m-e', { data: bytes('e'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-e', fileName: 'e.pdf', fileSize: 1 }))
    await h.runDeferred()
    expect(h.google.foldersNamed('ทีมหลัก')).toHaveLength(1)
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.line.pushes).toEqual([])
    expect(flexText(h.line.replies[0].messages[0])).not.toContain('ไม่ต้องมีบัญชี Google')
    expect(flexText(h.line.replies[0].messages[0])).not.toContain('เฉพาะเจ้าของ Drive')
  })

  it('a failed share check does not fail the save; the card then says nothing about access', async () => {
    const h = await setup()
    h.google.permsError = new AdapterError('google drive permissions 500')
    h.line.contents.set('m-p', { data: bytes('p'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-p', fileName: 'p.pdf', fileSize: 1 }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    const t = flexText(h.line.replies[0].messages[0])
    expect(t).not.toContain('ไม่ต้องมีบัญชี Google')
    expect(t).not.toContain('เฉพาะเจ้าของ Drive')
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
    h.google.uploadMs = 26_000 // past the 25 s reply window, inside the 28 s save budget
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-big', fileName: 'big.mp4', fileSize: 3 }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.line.replies).toEqual([])
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(SUB)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_saved', lineTargetId: SUB })])
  })

  it('a save inside 25 seconds is still a reply', async () => {
    const h = await setup()
    h.line.contents.set('m-mid', { data: bytes('mid'), contentType: 'application/zip' })
    h.google.uploadMs = 20_000
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
    h.google.uploadMs = 26_000
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

  it('an upload that would end past the deadline is cut, records nothing, and posts one "couldn\'t save" card in time', async () => {
    const h = await setup()
    h.line.contents.set('m-huge', { data: bytes('huge'), contentType: 'application/pdf' })
    h.google.uploadMs = 50_000
    const start = h.deps.now().getTime()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-huge', fileName: 'huge.pdf', fileSize: 4 }))
    await h.runDeferred()
    // The upload keeps POST_SAVE_RESERVE_MS back for the row and the card.
    expect(h.google.uploadTimeouts[0]).toBeLessThanOrEqual(SAVE_HARD_STOP_MS - POST_SAVE_RESERVE_MS)
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies).toEqual([]) // 45 s after the webhook: past the reply window
    expect(h.line.pushes).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('บันทึกไฟล์นี้ไม่ได้')
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_failed' })])
    expect(h.deps.now().getTime() - start).toBeLessThanOrEqual(SAVE_HARD_STOP_MS)
  })

  it('an upload with too little time left is not started', async () => {
    const h = await setup()
    h.line.contents.set('m-late', { data: bytes('late'), contentType: 'application/pdf' })
    h.line.contentMs = 27_500 // the download leaves under a second of the 28 s save budget
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-late', fileName: 'late.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.google.uploadTimeouts).toEqual([])
    expect(h.store.tables.files).toEqual([])
    expect(cardTexts(h)).toHaveLength(1)
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

  it('a batch without total whose photos arrive 5 s apart still gets one card for all of them', async () => {
    const h = await setup()
    for (const i of [1, 2]) h.line.contents.set(`m-t${i}`, { data: bytes(`t ${i}`), contentType: 'image/jpeg' })
    // The second photo's webhook comes 5 s after the first; with a wait shorter than that,
    // the first job would claim the batch alone.
    const arriveAt = h.deps.now().getTime() + 5_000
    let arrived = false
    const second = () => send(h, ev.groupImage({ groupId: SUB, messageId: 'm-t2', imageSet: { id: 'set-T' } }))
    h.deps.sleep = async (ms) => {
      const end = h.deps.now().getTime() + ms
      if (!arrived && end >= arriveAt) {
        arrived = true
        h.setNow(new Date(Math.max(arriveAt, h.deps.now().getTime())))
        await second()
      }
      h.setNow(new Date(Math.max(end, h.deps.now().getTime())))
    }
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-t1', imageSet: { id: 'set-T' } }))
    await h.runDeferred()
    if (!arrived) {
      arrived = true
      h.setNow(new Date(Math.max(arriveAt, h.deps.now().getTime())))
      await second()
      await h.runDeferred()
    }
    expect(arrived).toBe(true)
    expect(h.store.tables.files).toHaveLength(2)
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('2 รูป')
  })

  it('a photo that arrives and settles during the first job\'s wait makes the first job step back', async () => {
    const h = await setup()
    for (const i of [1, 2]) h.line.contents.set(`m-k${i}`, { data: bytes(`k ${i}`), contentType: 'image/jpeg' })
    let releaseB = () => {}
    const gateB = new Promise<void>((r) => { releaseB = r })
    let bParked = () => {}
    const parkedB = new Promise<void>((r) => { bParked = r })
    let runB: Promise<void> | null = null
    h.deps.sleep = async (ms) => {
      if (runB === null) {
        // First job (photo 1) waits: photo 2 arrives, saves and starts its own wait.
        await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-k2', imageSet: { id: 'set-K' }, replyToken: 'rt-k2' }))
        runB = h.runDeferred()
        await parkedB
        h.setNow(new Date(h.deps.now().getTime() + ms))
        return
      }
      bParked()
      await gateB
      h.setNow(new Date(h.deps.now().getTime() + ms))
    }
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-k1', imageSet: { id: 'set-K' }, replyToken: 'rt-k1' }))
    await h.runDeferred()
    // Photo 1's job is done: it saw a new photo in the set and claimed nothing.
    expect(h.store.tables.image_set_cards).toEqual([])
    releaseB()
    await runB
    expect(h.line.replies.map((r) => r.replyToken)).toEqual(['rt-k2'])
    expect(cardTexts(h)[0]).toContain('2 รูป')
  })

  it('a batch with a photo that failed still gets its card, with what was saved', async () => {
    const h = await setup()
    h.line.contents.set('m-u1', { data: bytes('u1'), contentType: 'image/jpeg' })
    h.line.contents.set('m-u3', { data: bytes('u3'), contentType: 'image/jpeg' })
    // m-u2 is gone from LINE: it settles as failed.
    await send(h,
      ev.groupImage({ groupId: SUB, messageId: 'm-u1', imageSet: { id: 'set-U', index: 1, total: 3 } }),
      ev.groupImage({ groupId: SUB, messageId: 'm-u2', imageSet: { id: 'set-U', index: 2, total: 3 } }),
      ev.groupImage({ groupId: SUB, messageId: 'm-u3', imageSet: { id: 'set-U', index: 3, total: 3 } }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(2)
    const cards = cardTexts(h)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toContain('2 รูป')
    expect(cards[0]).toContain('อีก 1 รูปบันทึกไม่ได้')
  })

  it('two identical photos in one batch (the second is linked, #140) still complete the batch', async () => {
    const h = await setup()
    h.line.contents.set('m-w1', { data: bytes('same photo'), contentType: 'image/jpeg' })
    h.line.contents.set('m-w2', { data: bytes('same photo'), contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-w1', imageSet: { id: 'set-W', index: 1, total: 2 } }))
    await h.runDeferred()
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-w2', imageSet: { id: 'set-W', index: 2, total: 2 } }))
    await h.runDeferred()
    // #140: the files row keeps m-w1 and m-w2 gets a link; both count through their settled rows.
    expect(h.store.tables.files[0].messageId).toBe(messageId(h, 'm-w1'))
    expect(h.store.tables.file_messages).toEqual([expect.objectContaining({ fileId: h.store.tables.files[0].id, messageId: messageId(h, 'm-w2') })])
    expect(h.google.uploads).toHaveLength(1)
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

  it('a duplicate (same hash) is saved once; the first and the new message both answer a quote-reply (#140)', async () => {
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
    expect(h.store.tables.files[0].messageId).toBe(messageId(h, 'm-a'))
    expect(h.line.replies).toHaveLength(2)
    expect(flexText(h.line.replies[1].messages[0])).toContain('เคยบันทึกไว้แล้ว')
    expect(JSON.stringify(h.line.replies[1].messages[0])).toContain(h.google.uploads[0].webViewLink)

    // #33: quoting the re-sent message gives the stored link.
    await send(h, ev.groupText({ groupId: SUB, text: 'NongJoDII ขอไฟล์', quotedMessageId: 'm-b', replyToken: 'rt-ask' }))
    await h.runDeferred()
    const answer = h.line.replies.find((r) => r.replyToken === 'rt-ask')!
    expect(JSON.stringify(answer.messages)).toContain(h.google.uploads[0].webViewLink)

    // #140: quoting the first message still gives it (before, its link had moved to m-b).
    await send(h, ev.groupText({ groupId: SUB, text: 'NongJoDII ขอไฟล์', quotedMessageId: 'm-a', replyToken: 'rt-first' }))
    await h.runDeferred()
    const first = h.line.replies.find((r) => r.replyToken === 'rt-first')!
    expect(JSON.stringify(first.messages)).toContain(h.google.uploads[0].webViewLink)

    // An unsend of the re-sent message drops its link; the file and the first message stay.
    await send(h, ev.unsend({ groupId: SUB, messageId: 'm-b' }))
    await h.runDeferred()
    expect(h.store.tables.file_messages).toEqual([])
    expect(h.store.tables.files).toHaveLength(1)
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
    // A pause, not a failure: the one sign-in card goes to the main group (#14), and the
    // group gets no "couldn't save" card for each file. #99: one pause notice, as a reply
    // to the first photo only (once per group per day).
    expect(h.line.pushes).toHaveLength(1)
    expect(h.line.pushes[0].to).toBe(MAIN)
    expect(h.line.pushes[0].messages[0]).toMatchObject({ type: 'flex', altText: 'กรุณาเข้าสู่ระบบ Google อีกครั้ง' })
    expect(h.line.replies).toHaveLength(1)
    expect(h.line.replies[0].messages).toEqual([expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noDrive })])
    expect(h.store.tables.webhook_events.filter((w) => w.webhookEventId.startsWith('file:'))).toEqual([])
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

  it('pauses after the Owner leaves the group (owner_left_at set): no save, only the pause notice (#99)', async () => {
    const h = await setup()
    h.store.seedMember({ groupId: h.subId, lineUserId: OWNER, displayName: 'Owner Name' })
    await send(h, ev.memberLeft({ groupId: SUB, userIds: [OWNER] }))
    await h.runDeferred()
    const sub = h.store.tables.groups.find((g) => g.id === h.subId)!
    expect(sub.ownerLeftAt).not.toBeNull()
    expect(sub.ownerConfirmedAt).toBeNull()

    h.line.contents.set('m-y', { data: bytes('y'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-y', fileName: 'y.pdf', fileSize: 1, replyToken: 'rt-y' }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
    expect(h.google.uploads).toEqual([])
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies.filter((r) => r.replyToken === 'rt-y').map((r) => r.messages)).toEqual([[expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noOwner })]])
    expect(h.store.tables.messages.some((m) => m.lineMessageId === 'm-y')).toBe(true)
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
    expect(cardTexts(h)[0]).toContain('100 MB')
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

  it('content LINE no longer has gets one "couldn\'t save" card', async () => {
    const h = await setup()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-gone', fileName: 'gone.pdf', fileSize: 1, replyToken: 'rt-gone' }))
    await h.runDeferred()
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies.map((r) => r.replyToken)).toEqual(['rt-gone'])
    expect(flexText(h.line.replies[0].messages[0])).toContain('บันทึกไฟล์นี้ไม่ได้')
  })

  it('a failed save and then a redelivery post one "couldn\'t save" card', async () => {
    const h = await setup()
    h.line.contents.set('m-f', { data: bytes('f'), contentType: 'application/pdf' })
    h.line.failContent = true
    const e = ev.groupFile({ groupId: SUB, messageId: 'm-f', fileName: 'f.pdf', fileSize: 1, eventId: 'ev-f' })
    await send(h, e)
    await h.runDeferred()
    await send(h, { ...e, deliveryContext: { isRedelivery: true } })
    await h.runDeferred()
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('บันทึกไฟล์นี้ไม่ได้')
    expect(h.store.tables.files).toEqual([])
  })

  it('a second run of the same failed message posts no second card', async () => {
    const h = await setup()
    h.line.failContent = true
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-g', fileName: 'g.pdf', fileSize: 1 }))
    const job = h.deferred[0]
    await h.runDeferred()
    await job() // the same jobs again, as a duplicate run would
    expect(cardTexts(h)).toHaveLength(1)
  })

  it('an image with no fileSize that is over the cap is stopped while downloading', async () => {
    const h = await setup()
    // Only byteLength is read before the cap stops it: no need for 100 MB of memory.
    h.line.contents.set('m-huge-img', { data: { byteLength: MAX_FILE_BYTES + 1 } as Uint8Array, contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-huge-img', replyToken: 'rt-huge' }))
    await h.runDeferred()
    expect(h.line.contentCalls[0].maxBytes).toBe(MAX_FILE_BYTES)
    expect(h.google.uploads).toEqual([])
    expect(h.store.tables.files).toEqual([])
    expect(flexText(h.line.replies[0].messages[0])).toContain('100 MB')
  })

  it('an external image (no LINE content) is not downloaded', async () => {
    const h = await setup()
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-ext', external: true }))
    await h.runDeferred()
    expect(h.line.contentCalls).toEqual([])
  })
})


describe('file saver review fixes (#4, PR #96)', () => {
  const logged = (event: string) =>
    [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls]
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .filter((e) => e.event === event)

  it('1. a store error before the upload settles the message and posts one "couldn\'t save" card', async () => {
    const h = await setup()
    h.line.contents.set('m-se', { data: bytes('se'), contentType: 'application/pdf' })
    h.store.failNext('findFileByHash')
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-se', fileName: 'se.pdf', fileSize: 2 }))
    await h.runDeferred()
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('บันทึกไฟล์นี้ไม่ได้')
    // #99: the settled row carries the reason.
    expect(h.store.tables.webhook_events.find((w) => w.webhookEventId === 'file:m-se')?.eventType).toBe('file_save_failed:failed')
  })

  it('1. a store error after the upload logs the Drive copy and does not block the batch', async () => {
    const h = await setup()
    for (const i of [1, 2]) h.line.contents.set(`m-sb${i}`, { data: bytes(`sb ${i}`), contentType: 'image/jpeg' })
    h.store.failNext('insertFile')
    await send(h,
      ev.groupImage({ groupId: SUB, messageId: 'm-sb1', imageSet: { id: 'set-SB', index: 1, total: 2 } }),
      ev.groupImage({ groupId: SUB, messageId: 'm-sb2', imageSet: { id: 'set-SB', index: 2, total: 2 } }))
    await h.runDeferred()
    expect(h.google.uploads).toHaveLength(2)
    expect(h.store.tables.files).toHaveLength(1)
    const orphan = logged('file_save_orphan')
    expect(orphan).toHaveLength(1)
    expect(h.google.uploads.map((u) => u.id)).toContain(orphan[0].driveFileId)
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('1 รูป')
    expect(cardTexts(h)[0]).toContain('อีก 1 รูปบันทึกไม่ได้')
  })

  it('1. a store error in the first read is a failure too: one card, the message not lost', async () => {
    const h = await setup()
    h.line.contents.set('m-g0', { data: bytes('g0'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-g0', fileName: 'g0.pdf', fileSize: 2 }))
    h.store.failNext('getGroupById')
    await h.runDeferred()
    expect(cardTexts(h)).toHaveLength(1)
    expect(h.line.contentCalls).toEqual([])
  })

  it('3. the worst case (save at the budget end, then a push with slow LINE calls) ends before 60 s', async () => {
    const h = await setup()
    h.line.contents.set('m-wc', { data: bytes('wc'), contentType: 'application/pdf' })
    h.google.uploadMs = SAVE_HARD_STOP_MS - POST_SAVE_RESERVE_MS - 1_000 // ends just inside the save budget
    h.line.quotaMs = 10_000 // the quota read (beside the member count), as slow as the client allows
    h.line.pushMs = 10_000
    const start = h.deps.now().getTime()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-wc', fileName: 'wc.pdf', fileSize: 2 }))
    await h.runDeferred()
    expect(h.line.pushes).toHaveLength(1)
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.deps.now().getTime() - start).toBeLessThan(60_000)
    expect(POST_SAVE_RESERVE_MS).toBeGreaterThanOrEqual(PUSH_WORST_MS)
    expect(PUSH_WORST_MS).toBeGreaterThanOrEqual(22_000)
  })

  it('3. a reply refused after a slow reply call falls back to a push only when the push still fits', async () => {
    for (const [uploadMs, pushes] of [[20_000, 1], [24_000, 0]] as const) {
      const h = await setup()
      h.line.contents.set('m-r4', { data: bytes('r4'), contentType: 'application/pdf' })
      h.line.rejectReply = true
      h.line.replyMs = 10_000
      h.line.quotaMs = 10_000
      h.line.pushMs = 10_000
      // Saved at 20 s: the refused reply ends at 30 s, 25 s are left, the 22 s push fits.
      // Saved at 24 s: the reply ends at 34 s, 21 s are left: no push.
      h.google.uploadMs = uploadMs
      const start = h.deps.now().getTime()
      await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-r4', fileName: 'r4.pdf', fileSize: 2 }))
      await h.runDeferred()
      expect(h.line.replies).toHaveLength(1)
      expect(h.line.pushes).toHaveLength(pushes)
      expect(h.deps.now().getTime() - start).toBeLessThan(60_000)
    }
  })

  it('4. a settled-row store error still sends the saved card', async () => {
    const h = await setup()
    h.line.contents.set('m-st', { data: bytes('st'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-st', fileName: 'st.pdf', fileSize: 2 }))
    h.store.failNext('recordWebhookEvent') // the settle (the webhook's own ledger row is in)
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    expect(h.line.replies).toHaveLength(1)
  })

  it('4. a settled-row store error on a failed save still sends the "couldn\'t save" card', async () => {
    const h = await setup()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-sf', fileName: 'sf.pdf', fileSize: 2 }))
    h.store.failNext('recordWebhookEvent')
    await h.runDeferred()
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('บันทึกไฟล์นี้ไม่ได้')
  })

  it('5. a second run of a saved message sends no second saved card', async () => {
    const h = await setup()
    h.line.contents.set('m-2r', { data: bytes('2r'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-2r', fileName: '2r.pdf', fileSize: 2 }))
    const job = h.deferred[0]
    await h.runDeferred()
    await job()
    expect(h.line.replies).toHaveLength(1)
    expect(h.google.uploads).toHaveLength(1)
  })

  it('6. a late batch without total still waits, for the time left', async () => {
    const h = await setup()
    h.line.contents.set('m-lw', { data: bytes('lw'), contentType: 'image/jpeg' })
    h.google.uploadMs = 25_000
    const waits: number[] = []
    const sleep = h.deps.sleep!
    h.deps.sleep = async (ms) => {
      waits.push(ms)
      return sleep(ms)
    }
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-lw', imageSet: { id: 'set-LW' } }))
    await h.runDeferred()
    expect(waits).toHaveLength(1)
    expect(waits[0]).toBeGreaterThan(0)
    expect(waits[0]).toBeLessThan(BATCH_QUIET_MS)
    expect(cardTexts(h)).toHaveLength(1)
  })

  it('7. the batch card takes the link state from the folder, not from the last photo to settle', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new DriveShareRefused()
    h.line.contents.set('m-ls1', { data: bytes('same'), contentType: 'image/jpeg' })
    h.line.contents.set('m-ls2', { data: bytes('same'), contentType: 'image/jpeg' })
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-ls1', imageSet: { id: 'set-LS', index: 1, total: 2 } }))
    await h.runDeferred()
    // The last photo is a duplicate: it never asked Drive about the share.
    await send(h, ev.groupImage({ groupId: SUB, messageId: 'm-ls2', imageSet: { id: 'set-LS', index: 2, total: 2 } }))
    await h.runDeferred()
    const card = h.line.replies.map((r) => flexText(r.messages[0])).find((t) => t.includes('2 รูป'))!
    expect(card).toContain('เฉพาะเจ้าของ Drive')
    expect(card).not.toContain('ไม่ต้องมีบัญชี Google')
  })

  it('8. a reply that times out or gets a 5xx is not pushed again', async () => {
    const h = await setup()
    h.line.contents.set('m-r5', { data: bytes('r5'), contentType: 'application/pdf' })
    h.line.failReply = true
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-r5', fileName: 'r5.pdf', fileSize: 2 }))
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expect(h.line.pushes).toEqual([])
  })

  it('8. a reply refused with a 4xx falls back to a push', async () => {
    const h = await setup()
    h.line.contents.set('m-r6', { data: bytes('r6'), contentType: 'application/pdf' })
    h.line.rejectReply = true
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-r6', fileName: 'r6.pdf', fileSize: 2 }))
    await h.runDeferred()
    expect(h.line.pushes).toHaveLength(1)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_saved' })])
  })

  it('9. no usable Drive (the Google account is revoked) is a pause: no "couldn\'t save" card', async () => {
    const h = await setup()
    h.store.tables.google_accounts[0].tokenStatus = 'revoked'
    h.line.contents.set('m-nd', { data: bytes('nd'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-nd', fileName: 'nd.pdf', fileSize: 2 }))
    await h.runDeferred()
    // #99: only the pause notice, a text reply.
    expect(h.line.replies.map((r) => r.messages)).toEqual([[expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noDrive })]])
    expect(h.line.pushes).toEqual([])
    expect(h.store.tables.files).toEqual([])
  })

  it('10. a refused folder costs no share checks on later saves the same day', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new DriveShareRefused()
    for (const i of [1, 2, 3]) h.line.contents.set(`m-rd${i}`, { data: bytes(`rd ${i}`), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-rd1', fileName: 'rd1.pdf', fileSize: 4 }))
    await h.runDeferred()
    h.google.driveCalls = []
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-rd2', fileName: 'rd2.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.google.driveCalls.filter((c) => c.startsWith('perms:') || c.startsWith('share:'))).toEqual([])
    expect(h.store.tables.files).toHaveLength(2)
    // The next Bangkok day checks again.
    h.setNow(new Date(h.deps.now().getTime() + 24 * 3600_000))
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-rd3', fileName: 'rd3.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.google.driveCalls.filter((c) => c.startsWith('perms:'))).toHaveLength(1)
  })

  it('11. an Owner card skipped near the quota is not remembered, so a later refusal posts it', async () => {
    const h = await setup({ layOut: false })
    h.google.shareError = new DriveShareRefused()
    h.line.quota = { limit: 300, used: 299 }
    h.line.contents.set('m-q1', { data: bytes('q1'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-q1', fileName: 'q1.pdf', fileSize: 2 }))
    await h.runDeferred()
    const ownerCards = () => h.line.pushes.filter((p) => flexText(p.messages[0]).includes(SHARE_REFUSED_TEXT.title))
    expect(ownerCards()).toEqual([])
    expect(h.store.tables.webhook_events.some((w) => w.webhookEventId.startsWith('drive_share_refused:'))).toBe(false)
    h.line.quota = { limit: 300, used: 0 }
    h.setNow(new Date(h.deps.now().getTime() + 24 * 3600_000))
    h.line.contents.set('m-q2', { data: bytes('q2'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-q2', fileName: 'q2.pdf', fileSize: 2 }))
    await h.runDeferred()
    expect(ownerCards()).toHaveLength(1)
    expect(h.store.tables.webhook_events.some((w) => w.webhookEventId.startsWith('drive_share_refused:'))).toBe(true)
  })
})

describe('the sender is told why (#99)', () => {
  const failWith = async (prepare: (h: H) => void) => {
    const h = await setup()
    h.line.contents.set('m-r', { data: bytes('r'), contentType: 'application/pdf' })
    prepare(h)
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-r', fileName: 'r.pdf', fileSize: 1, replyToken: 'rt-r' }))
    await h.runDeferred()
    expect(h.store.tables.files).toEqual([])
    expect(cardTexts(h)).toHaveLength(1)
    return { h, card: cardTexts(h)[0] }
  }

  it('each failure reason has its own caption, above the "save it yourself" line', async () => {
    const cases: [string, (h: H) => void, string][] = [
      ['timeout', (h) => { h.google.uploadError = new AdapterError('google timeout') }, FILE_SAVED_TEXT.timeout],
      ['gone', (h) => { h.line.contents.delete('m-r') }, FILE_SAVED_TEXT.gone],
      ['drive_full', (h) => { h.google.uploadError = new DriveStorageFull() }, FILE_SAVED_TEXT.driveFull],
      ['failed', (h) => { h.google.uploadError = new AdapterError('google drive upload 500') }, FILE_SAVED_TEXT.failed],
    ]
    for (const [reason, prepare, caption] of cases) {
      const { h, card } = await failWith(prepare)
      expect(card, reason).toContain(caption)
      expect(card, reason).toContain(FILE_SAVED_TEXT.failedBody)
      expect(h.store.tables.webhook_events.find((w) => w.webhookEventId === 'file:m-r')?.eventType).toBe(`file_save_failed:${reason}`)
    }
  })

  it('a file sent again after a failure is saved: nothing was stored the first time', async () => {
    const h = await setup()
    h.line.contents.set('m-1', { data: bytes('same'), contentType: 'application/pdf' })
    h.line.contents.set('m-2', { data: bytes('same'), contentType: 'application/pdf' })
    h.google.uploadError = new DriveStorageFull()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-1', fileName: 's.pdf', fileSize: 4 }))
    await h.runDeferred()
    h.google.uploadError = null
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-2', fileName: 's.pdf', fileSize: 4 }))
    await h.runDeferred()
    expect(h.store.tables.files).toHaveLength(1)
    expect(cardTexts(h)[1]).not.toContain(FILE_SAVED_TEXT.duplicate)
  })

  const batch = async (h: H, set: string, ids: string[]) => {
    await send(h, ...ids.map((id, i) => ev.groupImage({ groupId: SUB, messageId: id, imageSet: { id: set, index: i + 1, total: ids.length } })))
    await h.runDeferred()
  }

  it('a batch whose photos all failed for one reason names it', async () => {
    const h = await setup()
    for (const id of ['m-a1', 'm-a2']) h.line.contents.set(id, { data: bytes(id), contentType: 'image/jpeg' })
    h.google.uploadError = new DriveStorageFull()
    await batch(h, 'set-A', ['m-a1', 'm-a2'])
    expect(cardTexts(h)).toHaveLength(1)
    expect(cardTexts(h)[0]).toContain('บันทึกรูป 2 รูปไม่ได้')
    expect(cardTexts(h)[0]).toContain(FILE_SAVED_TEXT.driveFull)
  })

  it('a batch whose photos failed for different reasons gets the generic caption', async () => {
    const h = await setup()
    h.line.contents.set('m-b1', { data: bytes('b1'), contentType: 'image/jpeg' })
    // m-b2 is gone from LINE; m-b1 fails at the upload.
    h.google.uploadError = new AdapterError('google drive upload 500')
    await batch(h, 'set-B', ['m-b1', 'm-b2'])
    expect(cardTexts(h)[0]).toContain(FILE_SAVED_TEXT.failed)
    expect(cardTexts(h)[0]).not.toContain(FILE_SAVED_TEXT.gone)
  })

  it('a batch with some photos saved names the reason of the ones that failed', async () => {
    const h = await setup()
    h.line.contents.set('m-c1', { data: bytes('c1'), contentType: 'image/jpeg' })
    await batch(h, 'set-C', ['m-c1', 'm-c2']) // m-c2 is gone
    expect(cardTexts(h)[0]).toContain(`${FILE_SAVED_TEXT.photosFailedToo(1)}: ${FILE_SAVED_TEXT.gone}`)
  })

  it('a paused save tells the group once per Bangkok day; the next day it tells again', async () => {
    const h = await setup()
    h.store.tables.groups.find((g) => g.id === h.subId)!.ownerConfirmedAt = null
    const file = (id: string) => ev.groupFile({ groupId: SUB, messageId: id, fileName: `${id}.pdf`, fileSize: 1, replyToken: `rt-${id}` })
    await send(h, file('p1'))
    await h.runDeferred()
    await send(h, file('p2'))
    await h.runDeferred()
    expect(h.line.replies.map((r) => r.replyToken)).toEqual(['rt-p1'])
    expect(h.line.replies[0].messages).toEqual([expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noOwner })])
    expect(h.line.pushes).toEqual([])

    h.setNow(new Date(h.deps.now().getTime() + 24 * 60 * 60 * 1000))
    await send(h, file('p3'))
    await h.runDeferred()
    expect(h.line.replies.map((r) => r.replyToken)).toEqual(['rt-p1', 'rt-p3'])
  })

  it('another Google account holding the Project is a pause with the Drive notice', async () => {
    const h = await setup()
    h.store.tables.drive_connections.find((c) => c.projectId === h.projectId && c.status === 'active')!.googleAccountId = 'other-account'
    h.line.contents.set('m-o', { data: bytes('o'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-o', fileName: 'o.pdf', fileSize: 1, replyToken: 'rt-o' }))
    await h.runDeferred()
    expect(h.store.tables.files).toEqual([])
    expect(h.line.replies.map((r) => r.messages)).toEqual([[expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noDrive })]])
  })

  it('file saving turned off stays silent', async () => {
    const h = await setup()
    h.store.tables.group_setups.find((r) => r.groupId === h.subId)!.featureSaveFiles = false
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-off', fileName: 'off.pdf', fileSize: 1, replyToken: 'rt-off' }))
    await h.runDeferred()
    expect(h.line.replies).toEqual([])
    expect(h.store.tables.webhook_events.some((w) => w.webhookEventId.startsWith('file_paused:'))).toBe(false)
  })

  it('a large file gets "saving…" at once, then its card as a push through the budget', async () => {
    const h = await setup()
    h.line.contents.set('m-L', { data: bytes('large'), contentType: 'video/mp4' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-L', fileName: 'demo.mp4', fileSize: SAVING_NOTICE_BYTES + 1, replyToken: 'rt-L' }))
    await h.runDeferred()
    expect(h.line.replies.map((r) => r.replyToken)).toEqual(['rt-L'])
    expect(h.line.replies[0].messages).toEqual([{ type: 'text', text: FILE_NOTICE_TEXT.saving('demo.mp4') }])
    expect(h.line.pushes).toHaveLength(1)
    expect(flexText(h.line.pushes[0].messages[0])).toContain(FILE_SAVED_TEXT.fileTitle)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_saved', lineTargetId: SUB })])
  })

  it('a large file that fails gets "saving…", then the "couldn\'t save" card as a push', async () => {
    const h = await setup()
    h.line.contents.set('m-LF', { data: bytes('large'), contentType: 'video/mp4' })
    h.google.uploadError = new DriveStorageFull()
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-LF', fileName: 'big.mp4', fileSize: SAVING_NOTICE_BYTES + 1, replyToken: 'rt-LF' }))
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expect(flexText(h.line.pushes[0].messages[0])).toContain(FILE_SAVED_TEXT.driveFull)
    expect(h.store.tables.push_log).toEqual([expect.objectContaining({ purpose: 'file_failed' })])
  })

  it('a large file that meets a pause after "saving…" is told every time, by push', async () => {
    const h = await setup()
    h.store.tables.google_accounts[0].tokenStatus = 'revoked'
    for (const id of ['m-LP1', 'm-LP2']) {
      h.line.contents.set(id, { data: bytes(id), contentType: 'video/mp4' })
      await send(h, ev.groupFile({ groupId: SUB, messageId: id, fileName: `${id}.mp4`, fileSize: SAVING_NOTICE_BYTES + 1, replyToken: `rt-${id}` }))
      await h.runDeferred()
    }
    expect(h.line.replies.map((r) => r.messages[0])).toEqual([
      { type: 'text', text: FILE_NOTICE_TEXT.saving('m-LP1.mp4') }, { type: 'text', text: FILE_NOTICE_TEXT.saving('m-LP2.mp4') },
    ])
    const toSub = h.line.pushes.filter((p) => p.to === SUB)
    expect(toSub.map((p) => p.messages)).toEqual([[expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noDrive })], [expect.objectContaining({ type: 'flex', altText: FILE_NOTICE_TEXT.noDrive })]])
  })

  it('a file at or under the threshold keeps the single reply', async () => {
    const h = await setup()
    h.line.contents.set('m-S', { data: bytes('small'), contentType: 'application/pdf' })
    await send(h, ev.groupFile({ groupId: SUB, messageId: 'm-S', fileName: 's.pdf', fileSize: SAVING_NOTICE_BYTES, replyToken: 'rt-S' }))
    await h.runDeferred()
    expect(h.line.replies).toHaveLength(1)
    expect(flexText(h.line.replies[0].messages[0])).toContain(FILE_SAVED_TEXT.fileTitle)
    expect(h.line.pushes).toEqual([])
  })
})
