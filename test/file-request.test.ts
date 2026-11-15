import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_REQUEST_TEXT, fileLinkReply } from '@/server/files/request'
import type { LineEvent } from '@/server/line/types'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #33 File request by quote-reply, through the webhook seam. #4 (File saver) writes the
// files rows; until it lands, these tests seed them.

const LINK = 'https://drive.google.com/file/d/drive-file-1/view'

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setup() {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store)
  const send = async (...events: LineEvent[]) => {
    expect((await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)).status).toBe(200)
    await h.runDeferred()
  }
  /** A photo message in the group, stored by ingest, with a files row pointing at it. */
  const sendSavedFile = async (p: { messageId: string; groupId?: string; fileName?: string; driveLink?: string }) => {
    await send(ev.groupImage({ messageId: p.messageId, groupId: p.groupId }))
    const stored = h.store.tables.messages.find((m) => m.lineMessageId === p.messageId)!
    h.store.seedFile({
      groupId: stored.groupId, messageId: stored.id,
      fileName: p.fileName ?? 'report.pdf', driveLink: p.driveLink ?? LINK,
    })
  }
  const ask = (p: { quotedMessageId?: string; replyToken: string; groupId?: string }) =>
    send(ev.groupText({ text: 'NongJoDII ขอไฟล์', ...p }))
  const repliesTo = (replyToken: string) => h.line.replies.filter((r) => r.replyToken === replyToken)
  return { ...h, group, send, sendSavedFile, ask, repliesTo }
}

describe('File request by quote-reply (#33)', () => {
  it('a quote-reply to a saved file message gets that file\'s Drive link as a reply, never a push', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file', fileName: 'report.pdf' })
    await t.ask({ quotedMessageId: 'm-file', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [fileLinkReply({ fileName: 'report.pdf', driveLink: LINK })] },
    ])
    const text = JSON.stringify(t.repliesTo('rt-ask')[0].messages)
    expect(text).toContain(LINK)
    expect(t.line.pushes).toEqual([])
  })

  it('the Thai name works too', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file' })
    await t.send(ev.groupText({ text: 'น้องจดดี ขอไฟล์', quotedMessageId: 'm-file', replyToken: 'rt-th' }))
    expect(JSON.stringify(t.repliesTo('rt-th'))).toContain(LINK)
  })

  it('a quote of a stored message with no saved file gets a short reply saying so', async () => {
    const t = setup()
    await t.send(ev.groupText({ text: 'ส่งงานพรุ่งนี้นะ', messageId: 'm-text' }))
    await t.ask({ quotedMessageId: 'm-text', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [{ type: 'text', text: FILE_REQUEST_TEXT.noFile }] },
    ])
    expect(t.line.pushes).toEqual([])
  })

  it('the command without a quote gets a short reply explaining how to use it', async () => {
    const t = setup()
    await t.ask({ replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [{ type: 'text', text: FILE_REQUEST_TEXT.howTo }] },
    ])
    expect(t.line.pushes).toEqual([])
  })

  it('a quote of a message the bot never stored gets a short reply', async () => {
    const t = setup()
    await t.ask({ quotedMessageId: 'm-never-seen', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [{ type: 'text', text: FILE_REQUEST_TEXT.unknown }] },
    ])
    expect(t.line.pushes).toEqual([])
  })

  it('a file message unsent before the request is handled without error (#24 deleted its stored copy)', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file' })
    await t.send(ev.unsend({ messageId: 'm-file' }))
    // The files row survives the unsend (ON DELETE SET NULL), but no longer points at a message.
    expect(t.store.tables.files.map((f) => f.messageId)).toEqual([null])
    await t.ask({ quotedMessageId: 'm-file', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [{ type: 'text', text: FILE_REQUEST_TEXT.unknown }] },
    ])
    expect(console.error).not.toHaveBeenCalled()
  })

  it('never answers with a file saved in another group', async () => {
    const t = setup()
    const other = seedOwnedGroup(t.store, { lineGroupId: 'Cgroup2', owner: 'Uowner2' })
    await t.sendSavedFile({ messageId: 'm-other', groupId: other.lineGroupId, driveLink: 'https://drive.google.com/file/d/secret/view' })
    await t.ask({ quotedMessageId: 'm-other', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toEqual([
      { replyToken: 'rt-ask', messages: [{ type: 'text', text: FILE_REQUEST_TEXT.unknown }] },
    ])
  })

  it('answers with the newest file when one message has several saved files', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file', driveLink: 'https://drive.google.com/file/d/old/view' })
    const stored = t.store.tables.messages.find((m) => m.lineMessageId === 'm-file')!
    t.store.seedFile({
      groupId: stored.groupId, messageId: stored.id, fileName: 'report.pdf', driveLink: LINK,
      savedAt: new Date('2026-11-12T04:00:00Z'),
    })
    await t.ask({ quotedMessageId: 'm-file', replyToken: 'rt-ask' })
    expect(JSON.stringify(t.repliesTo('rt-ask'))).toContain(LINK)
  })

  it('the request is not read as progress on a Task', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file' })
    await t.ask({ quotedMessageId: 'm-file', replyToken: 'rt-ask' })
    expect(t.repliesTo('rt-ask')).toHaveLength(1)
    expect(t.llm.requests).toEqual([])
  })

  it('a failed reply is logged, not thrown', async () => {
    const t = setup()
    await t.sendSavedFile({ messageId: 'm-file' })
    t.line.failReply = true
    await t.ask({ quotedMessageId: 'm-file', replyToken: 'rt-ask' })
    expect(console.error).toHaveBeenCalled()
  })
})
