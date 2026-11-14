import { createHmac, randomUUID } from 'node:crypto'
import type { LineEvent, LineMention } from '@/server/line/types'
import type { Defer, Deps, GroupRow } from '@/server/ports'
import { FakeGoogle } from './fakes/fake-google'
import { FakeLine } from './fakes/fake-line'
import { FakeLlm } from './fakes/fake-llm'
import { FakeStore } from './fakes/fake-store'

export const TEST_SECRET = 'test-channel-secret'
export const TEST_LIFF_ID = '2000000000-abcdefgh'
export const TEST_KEY = Buffer.alloc(32, 7)
export const TEST_TICK_SECRET = 'test-tick-secret'
/** Default clock: 10:00 in Bangkok. */
export const TEST_NOW = new Date('2026-11-12T03:00:00Z')

const DEFAULT_GROUP = 'Cgroup1'
const DEFAULT_USER = 'Uuser1'
const DEFAULT_OWNER = 'Uowner1'

export function makeTestDeps(opts?: { now?: Date }): {
  deps: Deps; line: FakeLine; llm: FakeLlm; google: FakeGoogle; store: FakeStore
  setNow(d: Date): void
  defer: Defer; deferred: Array<() => Promise<void>>; runDeferred(): Promise<void>
} {
  const line = new FakeLine()
  const llm = new FakeLlm()
  const google = new FakeGoogle()
  const store = new FakeStore()
  let current = new Date((opts?.now ?? TEST_NOW).getTime())
  const deferred: Array<() => Promise<void>> = []
  const deps: Deps = {
    line, llm, google, store,
    now: () => new Date(current.getTime()),
    config: { lineChannelSecret: TEST_SECRET, liffId: TEST_LIFF_ID, tokenEncryptionKey: TEST_KEY, tickSecret: TEST_TICK_SECRET },
  }
  return {
    deps, line, llm, google, store,
    setNow(d: Date) {
      current = new Date(d.getTime())
    },
    defer: (job) => {
      deferred.push(job)
    },
    deferred,
    /** Runs queued jobs in order, including jobs they defer, until none are left. */
    async runDeferred() {
      while (deferred.length > 0) {
        const job = deferred.shift() as () => Promise<void>
        await job()
      }
    },
  }
}

/** POST to the webhook route, signed with HMAC-SHA256(secret, body) in base64.
 *  `signature: null` omits the header; a string replaces the computed one. */
export function signedRequest(body: string, opts?: { secret?: string; signature?: string | null }): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  const signature =
    opts?.signature === undefined
      ? createHmac('sha256', opts?.secret ?? TEST_SECRET).update(body).digest('base64')
      : opts.signature
  if (signature !== null) headers.set('x-line-signature', signature)
  return new Request('http://test/api/line/webhook', { method: 'POST', headers, body })
}

/** POST to the tick route as Supabase pg_cron sends it. `secret: null` omits the
 *  x-tick-secret header; a string replaces the test secret. */
export function tickRequest(opts?: { secret?: string | null; method?: string }): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  const secret = opts?.secret === undefined ? TEST_TICK_SECRET : opts.secret
  if (secret !== null) headers.set('x-tick-secret', secret)
  const method = opts?.method ?? 'POST'
  return new Request('http://test/api/tick', {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify({ kind: 'tick' }),
  })
}

export function webhookBody(...events: LineEvent[]): string {
  return JSON.stringify({ destination: 'Ubot', events })
}

let seq = 0
function next(prefix: string): string {
  seq += 1
  return `${prefix}-${seq}`
}

export const ev: {
  groupText(p: { text: string; groupId?: string; userId?: string | null; eventId?: string; messageId?: string; timestamp?: number; replyToken?: string; redelivery?: boolean; mentionees?: LineMention[] }): LineEvent
  groupImage(p: { groupId?: string; userId?: string; eventId?: string; messageId?: string; imageSet?: { id: string; index?: number; total?: number } }): LineEvent
  userText(p: { text: string; userId?: string; eventId?: string }): LineEvent
  follow(p: { userId?: string; eventId?: string }): LineEvent
  groupPostback(p: { data: string; groupId?: string; userId?: string | null; eventId?: string; replyToken?: string; pickedDate?: string }): LineEvent
  join(p: { groupId?: string; eventId?: string; replyToken?: string; redelivery?: boolean }): LineEvent
  unsend(p: { messageId: string; groupId?: string; userId?: string; eventId?: string; redelivery?: boolean }): LineEvent
  memberLeft(p: { userIds: string[]; groupId?: string; eventId?: string; redelivery?: boolean; timestamp?: number }): LineEvent
  memberJoined(p: { userIds: string[]; groupId?: string; eventId?: string; timestamp?: number }): LineEvent
} = {
  groupText(p) {
    const userId = p.userId === undefined ? DEFAULT_USER : p.userId
    return {
      type: 'message',
      mode: 'active',
      timestamp: p.timestamp ?? TEST_NOW.getTime(),
      source: userId === null
        ? { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP }
        : { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP, userId },
      replyToken: p.replyToken ?? next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: p.redelivery ?? false },
      message: p.mentionees
        ? { id: p.messageId ?? next('msg'), type: 'text', text: p.text, mention: { mentionees: p.mentionees } }
        : { id: p.messageId ?? next('msg'), type: 'text', text: p.text },
    }
  },
  groupImage(p) {
    return {
      type: 'message',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP, userId: p.userId ?? DEFAULT_USER },
      replyToken: next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: false },
      message: p.imageSet
        ? { id: p.messageId ?? next('msg'), type: 'image', imageSet: p.imageSet }
        : { id: p.messageId ?? next('msg'), type: 'image' },
    }
  },
  userText(p) {
    return {
      type: 'message',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: { type: 'user', userId: p.userId ?? DEFAULT_USER },
      replyToken: next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: false },
      message: { id: next('msg'), type: 'text', text: p.text },
    }
  },
  groupPostback(p) {
    const userId = p.userId === undefined ? DEFAULT_USER : p.userId
    return {
      type: 'postback',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: userId === null
        ? { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP }
        : { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP, userId },
      replyToken: p.replyToken ?? next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: false },
      // pickedDate: what LINE's date picker sends back in postback.params.date (#45).
      postback: p.pickedDate ? { data: p.data, params: { date: p.pickedDate } } : { data: p.data },
    }
  },
  join(p) {
    // LINE sends no userId on a join: the bot was invited, nobody is the sender.
    return {
      type: 'join',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP },
      replyToken: p.replyToken ?? next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: p.redelivery ?? false },
    }
  },
  unsend(p) {
    // LINE's unsend event carries no replyToken; unsend.messageId is the unsent message's id (#24).
    return {
      type: 'unsend',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP, userId: p.userId ?? DEFAULT_USER },
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: p.redelivery ?? false },
      unsend: { messageId: p.messageId },
    }
  },
  memberJoined(p) {
    return {
      type: 'memberJoined',
      mode: 'active',
      timestamp: p.timestamp ?? TEST_NOW.getTime(),
      source: { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP },
      replyToken: next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: false },
      joined: { members: p.userIds.map((userId) => ({ type: 'user', userId })) },
    }
  },
  memberLeft(p) {
    // LINE sends memberLeft without a replyToken: anything the bot says about it is a push.
    return {
      type: 'memberLeft',
      mode: 'active',
      timestamp: p.timestamp ?? TEST_NOW.getTime(),
      source: { type: 'group', groupId: p.groupId ?? DEFAULT_GROUP },
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: p.redelivery ?? false },
      left: { members: p.userIds.map((userId) => ({ type: 'user', userId })) },
    }
  },
  follow(p) {
    return {
      type: 'follow',
      mode: 'active',
      timestamp: TEST_NOW.getTime(),
      source: { type: 'user', userId: p.userId ?? DEFAULT_USER },
      replyToken: next('rt'),
      webhookEventId: p.eventId ?? next('ev'),
      deliveryContext: { isRedelivery: false },
    }
  },
}

/** A group with a confirmed Owner (confirmed at TEST_NOW) in a Project, with the
 *  Owner and the given people as live Members under their LINE names. */
export function seedOwnedGroup(
  store: FakeStore,
  p?: {
    lineGroupId?: string; owner?: string
    members?: { lineUserId: string; displayName: string; nicknames?: string[]; role?: string }[]
  },
): GroupRow {
  const owner = p?.owner ?? DEFAULT_OWNER
  const group = store.seedGroup({
    lineGroupId: p?.lineGroupId ?? DEFAULT_GROUP,
    projectId: randomUUID(),
    nominatedOwnerLineUserId: owner,
    ownerConfirmedAt: new Date(TEST_NOW.getTime()),
  })
  const members = p?.members ?? []
  if (!members.some((m) => m.lineUserId === owner)) {
    store.seedMember({ groupId: group.id, lineUserId: owner, displayName: 'Owner' })
  }
  for (const m of members) store.seedMember({ groupId: group.id, ...m })
  return group
}
