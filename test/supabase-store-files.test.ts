import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@/server/log'
import { IN_CHUNK, SupabaseStore } from '@/server/store/supabase-store'

// SupabaseStore's #4 methods against a stand-in for the PostgREST builder: every chained
// call is recorded, and each request (one from() chain) answers the next queued answer.

type Answer = { data: unknown; error: { code: string; message: string } | null }
type Request = { table: string; calls: [string, ...unknown[]][] }

function standIn(answers: Answer[]) {
  const requests: Request[] = []
  const from = (table: string) => {
    const req: Request = { table, calls: [] }
    requests.push(req)
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle', 'upsert', 'update', 'insert']) {
      q[m] = (...args: unknown[]) => {
        req.calls.push([m, ...args])
        return q
      }
    }
    q.then = (resolve: (a: Answer) => void) => resolve(answers.shift() ?? { data: [], error: null })
    return q
  }
  return { store: new SupabaseStore({ from } as unknown as SupabaseClient), requests }
}

const dbFile = {
  id: 'f1', group_id: 'g1', message_id: 'msg-1', file_name: 'a.pdf', drive_link: 'https://d/f1',
  drive_file_id: 'd1', size_bytes: '1024',
}
const newFile = {
  groupId: 'g1', messageId: 'msg-2', senderLineUserId: 'U1', driveConnectionId: 'c1', fileName: 'a.pdf',
  contentSha256: 'h', driveFileId: 'd1', driveLink: 'https://d/f1', sentAt: new Date('2026-11-12T03:00:00Z'),
  savedAt: new Date('2026-11-12T03:00:05Z'), sizeBytes: 1024,
}

describe('SupabaseStore files (#4)', () => {
  it('insertFile inserts ON CONFLICT (group_id, content_sha256) DO NOTHING', async () => {
    const { store, requests } = standIn([{ data: [dbFile], error: null }])
    const got = await store.insertFile(newFile)
    expect(got).toEqual({ inserted: true, file: expect.objectContaining({ id: 'f1', sizeBytes: 1024 }) })
    const upsert = requests[0].calls.find((c) => c[0] === 'upsert')!
    expect(upsert[2]).toEqual({ onConflict: 'group_id,content_sha256', ignoreDuplicates: true })
    expect(upsert[1]).toMatchObject({ drive_connection_id: 'c1', size_bytes: 1024, message_id: 'msg-2', sender_line_user_id: 'U1' })
  })

  it('insertFile on a conflict answers the row that got in first', async () => {
    const { store, requests } = standIn([{ data: [], error: null }, { data: dbFile, error: null }])
    const got = await store.insertFile(newFile)
    expect(got.inserted).toBe(false)
    expect(got.file.id).toBe('f1')
    expect(requests[1].calls).toContainEqual(['eq', 'content_sha256', 'h'])
  })

  it('insertFile throws the Postgres code only', async () => {
    const { store } = standIn([{ data: null, error: { code: '23514', message: 'check violation with data' } }])
    const err = await store.insertFile(newFile).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as Error).message).toBe('supabase insertFile: 23514')
  })

  it('linkFileToMessage updates message_id by id', async () => {
    const { store, requests } = standIn([{ data: [{ id: 'f1' }], error: null }])
    expect(await store.linkFileToMessage('f1', 'msg-9')).toEqual({ updated: true })
    expect(requests[0].calls).toContainEqual(['update', { message_id: 'msg-9' }])
    expect(requests[0].calls).toContainEqual(['eq', 'id', 'f1'])
  })

  it('countImageSet counts the set messages and their settled rows in webhook_events', async () => {
    const { store, requests } = standIn([
      { data: [{ line_message_id: 'm1' }, { line_message_id: 'm2' }, { line_message_id: 'm3' }], error: null },
      { data: [{ webhook_event_id: 'file:m1', event_type: 'file_saved' }, { webhook_event_id: 'file:m3', event_type: 'file_save_failed' }], error: null },
    ])
    expect(await store.countImageSet('g1', 'set-1')).toEqual({ messages: 3, saved: 1, failed: 1 })
    expect(requests[0].calls).toContainEqual(['eq', 'image_set_id', 'set-1'])
    expect(requests[1].table).toBe('webhook_events')
    expect(requests[1].calls).toContainEqual(['in', 'webhook_event_id', ['file:m1', 'file:m2', 'file:m3']])
  })

  it('countImageSet asks the ledger IN_CHUNK keys at a time', async () => {
    const ids = Array.from({ length: IN_CHUNK + 50 }, (_, i) => ({ line_message_id: `m${i}` }))
    const { store, requests } = standIn([
      { data: ids, error: null },
      { data: [{ webhook_event_id: 'file:m0', event_type: 'file_saved' }], error: null },
      { data: [{ webhook_event_id: `file:m${IN_CHUNK}`, event_type: 'file_save_failed' }], error: null },
    ])
    expect(await store.countImageSet('g1', 'set-big')).toEqual({ messages: IN_CHUNK + 50, saved: 1, failed: 1 })
    const ins = requests.slice(1).map((r) => (r.calls.find((c) => c[0] === 'in')![2] as string[]).length)
    expect(ins).toEqual([IN_CHUNK, 50])
  })

  it('countImageSet of an empty set reads no ledger', async () => {
    const { store, requests } = standIn([{ data: [], error: null }])
    expect(await store.countImageSet('g1', 'set-x')).toEqual({ messages: 0, saved: 0, failed: 0 })
    expect(requests).toHaveLength(1)
  })

  it('claimImageSetCard claims only when a row came back', async () => {
    const won = standIn([{ data: [{ image_set_id: 's' }], error: null }])
    expect(await won.store.claimImageSetCard('g1', 's')).toEqual({ claimed: true })
    expect(won.requests[0].calls.find((c) => c[0] === 'upsert')![2]).toEqual({ onConflict: 'group_id,image_set_id', ignoreDuplicates: true })
    const lost = standIn([{ data: [], error: null }])
    expect(await lost.store.claimImageSetCard('g1', 's')).toEqual({ claimed: false })
  })

  it('findActiveDriveConnection reads the active row', async () => {
    const { store, requests } = standIn([{ data: [{ id: 'c1', google_account_id: 'a1' }], error: null }])
    expect(await store.findActiveDriveConnection('p1')).toEqual({ id: 'c1', googleAccountId: 'a1' })
    expect(requests[0].calls).toContainEqual(['eq', 'status', 'active'])
  })

  it('listDashboardFiles reads the newest files of each group with the sender name', async () => {
    const { store, requests } = standIn([
      { data: [{ ...dbFile, saved_at: '2026-11-12T03:00:05Z', line_users: { display_name: 'Sender' } }], error: null },
      { data: [], error: null },
    ])
    const got = await store.listDashboardFiles(['g1', 'g2'], 20)
    expect(got).toEqual([{
      id: 'f1', groupId: 'g1', fileName: 'a.pdf', driveLink: 'https://d/f1', sizeBytes: 1024,
      savedAt: new Date('2026-11-12T03:00:05Z'), senderName: 'Sender',
    }])
    expect(requests).toHaveLength(2)
    expect(requests[0].calls).toContainEqual(['limit', 20])
    expect(requests[0].calls).toContainEqual(['order', 'saved_at', { ascending: false }])
  })
})
