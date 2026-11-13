import type { LineEvent } from '@/server/line/types'
import type { Deps, MessageMention } from '@/server/ports'

export type Job =
  | {
      kind: 'group_message'; groupId: string; lineGroupId: string; messageId: string
      storedMessageId: string; sentAt: Date   // messages.id and send time (#7 progress cards)
      senderLineUserId: string | null; text: string | null; replyToken: string | null
    }
  | {
      // A button press in a group (#7 progress cards, #45 reminder cards). userId is optional on
      // postbacks. pickedDate: a date picker's choice ('YYYY-MM-DD'), null for other buttons.
      kind: 'group_postback'; groupId: string; lineGroupId: string
      userId: string | null; data: string; pickedDate: string | null; replyToken: string | null
    }
  | { kind: 'user_chat'; lineUserId: string; replyToken: string | null } // 1:1 follow or message (#12, Task 5)
  | { kind: 'group_join'; groupId: string; lineGroupId: string; replyToken: string | null } // bot joined (#52)

/** Stops at the first event that throws and returns the jobs collected before it,
 *  plus that error. Never throws itself. */
export async function ingestEvents(deps: Deps, events: LineEvent[]): Promise<{ jobs: Job[]; error: unknown | null }> {
  const jobs: Job[] = []
  try {
    for (const event of events) {
      const job = await ingestEvent(deps, event)
      if (job) jobs.push(job)
    }
    return { jobs, error: null }
  } catch (error) {
    return { jobs, error }
  }
}

async function ingestEvent(deps: Deps, event: LineEvent): Promise<Job | null> {
  const { store } = deps
  const { source, message } = event
  const eventTimestamp = new Date(event.timestamp)
  const isRedelivery = event.deliveryContext?.isRedelivery ?? false

  if (source.type === 'group' && event.type === 'message' && message) {
    const userId = source.userId ?? null
    if (userId) await store.upsertLineUser({ lineUserId: userId, displayName: null })
    const group = await store.ensureGroup(source.groupId)
    if (userId) await store.touchGroupMember(group.id, userId, 'message')
    await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'message', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    const text = message.type === 'text' && typeof message.text === 'string' ? message.text : null
    const imageSet = message.type === 'image' ? (message.imageSet as { id: string; index?: number; total?: number } | undefined) : undefined
    const { inserted, id: storedMessageId } = await store.insertMessage({
      groupId: group.id, webhookEventId: event.webhookEventId, lineMessageId: message.id,
      senderLineUserId: userId, messageType: message.type, text, sentAt: eventTimestamp,
      imageSetId: imageSet?.id ?? null, imageSetIndex: imageSet?.index ?? null, imageSetTotal: imageSet?.total ?? null,
      mentions: text === null ? null : readMentions((message as { mention?: unknown }).mention),
    })
    // Gate on the message row, not the ledger row: a half-failed first delivery is
    // retried, and a redelivery never runs twice.
    if (!inserted || storedMessageId === null) return null
    return {
      kind: 'group_message', groupId: group.id, lineGroupId: source.groupId, messageId: message.id,
      storedMessageId, sentAt: eventTimestamp,
      senderLineUserId: userId, text, replyToken: event.replyToken ?? null,
    }
  }

  if (source.type === 'group' && event.type === 'postback' && typeof event.postback?.data === 'string') {
    // Prerequisite writes first (both idempotent), the ledger claim last: if a write
    // fails, the event is not claimed yet, so LINE's redelivery still runs the press.
    const userId = source.userId ?? null
    // The presser is stored as a LINE user, so answered_by can point at them.
    if (userId) await store.upsertLineUser({ lineUserId: userId, displayName: null })
    const group = await store.ensureGroup(source.groupId)
    // The ledger row is the store-once gate: a redelivered press runs once.
    const { inserted } = await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'postback', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    if (!inserted) return null
    return {
      kind: 'group_postback', groupId: group.id, lineGroupId: source.groupId,
      userId, data: event.postback.data, pickedDate: event.postback.params?.date ?? null,
      replyToken: event.replyToken ?? null,
    }
  }

  if (source.type === 'group' && event.type === 'join') {
    // The group row first (idempotent), the ledger claim last, as for a postback: a
    // redelivered join answers once.
    const group = await store.ensureGroup(source.groupId)
    const { inserted } = await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'join', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    if (!inserted) return null
    return { kind: 'group_join', groupId: group.id, lineGroupId: source.groupId, replyToken: event.replyToken ?? null }
  }

  const { inserted } = await store.recordWebhookEvent({
    webhookEventId: event.webhookEventId, eventType: event.type,
    lineGroupId: source.type === 'group' ? source.groupId : null, eventTimestamp, isRedelivery,
  })
  // 1:1 follow or message. No messages row: messages.group_id is NOT NULL.
  if (inserted && source.type === 'user' && (event.type === 'follow' || event.type === 'message')) {
    return { kind: 'user_chat', lineUserId: source.userId, replyToken: event.replyToken ?? null }
  }
  // Every other event (leave, memberJoined, unsend, room...) is only
  // recorded; handling belongs to #2 and #11.
  return null
}

/** Keeps LINE's mention entries in the stored shape. The body passed the signature
 *  check but is still parsed JSON, so malformed entries are dropped, not trusted. */
function readMentions(mention: unknown): MessageMention[] | null {
  const mentionees = (mention as { mentionees?: unknown } | null | undefined)?.mentionees
  if (!Array.isArray(mentionees)) return null
  const out: MessageMention[] = []
  for (const raw of mentionees) {
    const m = raw as { index?: unknown; length?: unknown; type?: unknown; userId?: unknown } | null
    if (!m || (m.type !== 'user' && m.type !== 'all')) continue
    if (!Number.isInteger(m.index) || !Number.isInteger(m.length)) continue
    out.push({
      index: m.index as number, length: m.length as number, type: m.type,
      userId: m.type === 'user' && typeof m.userId === 'string' ? m.userId : null,
    })
  }
  return out.length > 0 ? out : null
}
