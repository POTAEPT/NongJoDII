import type { LineEvent } from '@/server/line/types'
import { recordMemberLeft } from '@/server/members/left'
import { markOwnerLeftOnLeave } from '@/server/members/owner-left'
import type { Deps, MessageMention, TaskRow } from '@/server/ports'

export type Job =
  | {
      kind: 'group_message'; groupId: string; lineGroupId: string; messageId: string
      storedMessageId: string; sentAt: Date   // messages.id and send time (#7 progress cards)
      senderLineUserId: string | null; text: string | null; replyToken: string | null
      quotedMessageId: string | null   // LINE message id this text quotes (#33); null when none
    }
  | {
      // A button press in a group (#7 progress cards, #45 reminder cards). userId is optional on
      // postbacks. pickedDate: a date picker's choice ('YYYY-MM-DD'), null for other buttons.
      kind: 'group_postback'; groupId: string; lineGroupId: string
      userId: string | null; data: string; pickedDate: string | null; replyToken: string | null
    }
  | {
      // #29: people who left a group (LINE memberLeft) and the open Tasks released from them,
      // already saved at ingest. eventId keys the one push the card may make.
      // #30 ownerLeft: the LINE user ID of the group's Owner when they are among the leavers
      // (owner_left_at already set at ingest), else null; the job then posts the owner_needed card.
      kind: 'member_left'; groupId: string; lineGroupId: string
      released: { lineUserId: string; tasks: TaskRow[] }[]; eventId: string; ownerLeft: string | null
    }
  | {
      // #4: a file or image sent in a group. LINE sends only the ID and metadata; the job
      // downloads the content. receivedAt: when the webhook request came in, which times
      // the reply token (one minute) and the route's limit.
      kind: 'group_file'; groupId: string; lineGroupId: string; storedMessageId: string; lineMessageId: string
      messageType: 'file' | 'image'; fileName: string | null; fileSize: number | null
      imageSet: { id: string; index: number | null; total: number | null } | null
      senderLineUserId: string | null; sentAt: Date; receivedAt: Date; replyToken: string | null
    }
  | { kind: 'user_chat'; lineUserId: string; replyToken: string | null } // 1:1 follow or message (#12, Task 5)
  | { kind: 'group_join'; groupId: string; lineGroupId: string; replyToken: string | null } // bot joined (#52)
  // #29: people who joined a group, already saved as Members at ingest. The Job answers with
  // the welcome reply and fetches their LINE names so pickers can tell new Members apart.
  | { kind: 'member_joined'; groupId: string; lineGroupId: string; lineUserIds: string[]; replyToken: string | null }

/** Stops at the first event that throws and returns the jobs collected before it,
 *  plus that error. Never throws itself. */
export async function ingestEvents(
  deps: Deps, events: LineEvent[], receivedAt: Date = deps.now(),
): Promise<{ jobs: Job[]; error: unknown | null }> {
  const jobs: Job[] = []
  try {
    for (const event of events) {
      const job = await ingestEvent(deps, event, receivedAt)
      if (job) jobs.push(job)
    }
    return { jobs, error: null }
  } catch (error) {
    return { jobs, error }
  }
}

async function ingestEvent(deps: Deps, event: LineEvent, receivedAt: Date): Promise<Job | null> {
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
    // Only text (and sticker) messages carry quotedMessageId; the bot reads it on text only.
    const quoted = message.type === 'text' ? (message as { quotedMessageId?: unknown }).quotedMessageId : undefined
    const quotedMessageId = typeof quoted === 'string' && quoted !== '' ? quoted : null
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
    const file = readFileMessage(message)
    if (file) {
      return {
        kind: 'group_file', groupId: group.id, lineGroupId: source.groupId, storedMessageId, lineMessageId: message.id,
        ...file, imageSet: imageSet && typeof imageSet.id === 'string'
          ? { id: imageSet.id, index: intOrNull(imageSet.index), total: intOrNull(imageSet.total) }
          : null,
        senderLineUserId: userId, sentAt: eventTimestamp, receivedAt, replyToken: event.replyToken ?? null,
      }
    }
    return {
      kind: 'group_message', groupId: group.id, lineGroupId: source.groupId, messageId: message.id,
      storedMessageId, sentAt: eventTimestamp,
      senderLineUserId: userId, text, replyToken: event.replyToken ?? null, quotedMessageId,
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
    let group = await store.ensureGroup(source.groupId)
    // #11 re-invite. Data already past its delete date goes now, whatever the purge's
    // timing, and the group starts fresh; inside the 7 days the mark is cleared (and,
    // with no confirmed Owner, the 7-day Owner count starts again). Both idempotent.
    if ((await store.purgeGroup(group.id, eventTimestamp)).purged) group = await store.ensureGroup(source.groupId)
    await store.markBotJoined({ groupId: group.id, at: eventTimestamp })
    const { inserted } = await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'join', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    if (!inserted) return null
    return { kind: 'group_join', groupId: group.id, lineGroupId: source.groupId, replyToken: event.replyToken ?? null }
  }

  if (source.type === 'group' && event.type === 'leave') {
    // #11: LINE removed the bot from the group. Mark first, the ledger row last, as for
    // unsend: a failed write answers 500 and LINE's redelivery retries it. The mark is set
    // only where none is (a leave the bot made itself already set it, and the date never
    // moves) and only when the leave is newer than the latest join, so a stale leave cannot
    // mark a re-invited group. By line_group_id: a group never stored gets no row.
    await store.markBotLeft({ lineGroupId: source.groupId, at: eventTimestamp })
    await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'leave', lineGroupId: source.groupId, eventTimestamp, isRedelivery,
    })
    return null
  }

  if (event.type === 'unsend' && typeof event.unsend?.messageId === 'string') {
    // Delete first, the ledger row last: a failed delete answers 500 before the event is
    // recorded, so LINE's redelivery retries it. The unsend is idempotent (an unknown or
    // already deleted message deletes nothing), so it needs no store-once gate and no Job.
    // It also keeps a tombstone of the message ID, so the message is not stored again when
    // its own event arrives late. Confirmed Tasks have no link to messages, so they stay (#24).
    await store.unsendMessage(event.unsend.messageId)
    await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'unsend',
      lineGroupId: source.type === 'group' ? source.groupId : null, eventTimestamp, isRedelivery,
    })
    return null
  }

  if (source.type === 'group' && event.type === 'memberLeft') {
    const lineUserIds = (event.left?.members ?? [])
      .filter((m) => m.type === 'user' && typeof m.userId === 'string')
      .map((m) => m.userId as string)
    // A redelivery of a leave that already ran (it was recorded, but LINE did not get our
    // answer) stops here: running its writes again could undo a rejoin that came since.
    if (await store.hasWebhookEvent(event.webhookEventId)) return null
    const group = await store.ensureGroup(source.groupId)
    // The leave itself first, the ledger row last, as for unsend: if a write fails, the
    // webhook answers 500 before the event is recorded and LINE's redelivery runs it again,
    // so a departed person never keeps access. Both writes are idempotent. Only the card
    // waits for the job, gated by the ledger row so a redelivered leave posts once. (A
    // redelivery after the writes but before the ledger row finds nothing left to release
    // and posts no card; the Tasks still show in the daily reminders.)
    const released = await recordMemberLeft(deps, { groupId: group.id, lineUserIds, at: eventTimestamp })
    // #30: the Owner among the leavers pauses the Owner-backed features, also before the ledger row.
    const ownerLeft = await markOwnerLeftOnLeave(deps, group, lineUserIds, eventTimestamp)
    const { inserted } = await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'memberLeft', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    if (!inserted || (released.length === 0 && ownerLeft === null)) return null
    return { kind: 'member_left', groupId: group.id, lineGroupId: source.groupId, released, eventId: event.webhookEventId, ownerLeft }
  }

  if (source.type === 'group' && event.type === 'memberJoined') {
    // #29: a person who joins is a Member at once, and a rejoin clears left_at, so they get
    // LIFF access back. Writes first, the ledger row last (as for a leave); both are
    // idempotent. The Job sends the welcome reply and fetches LINE names.
    // A redelivered join cannot undo a later leave: it only clears a left_at older than itself.
    const group = await store.ensureGroup(source.groupId)
    const lineUserIds: string[] = []
    for (const m of event.joined?.members ?? []) {
      if (m.type !== 'user' || typeof m.userId !== 'string') continue
      await store.upsertLineUser({ lineUserId: m.userId, displayName: null })
      await store.markMemberJoined({ groupId: group.id, lineUserId: m.userId, at: eventTimestamp })
      lineUserIds.push(m.userId)
    }
    const { inserted } = await store.recordWebhookEvent({
      webhookEventId: event.webhookEventId, eventType: 'memberJoined', lineGroupId: source.groupId,
      eventTimestamp, isRedelivery,
    })
    return inserted && lineUserIds.length > 0 ? {
      kind: 'member_joined', groupId: group.id, lineGroupId: source.groupId, lineUserIds, replyToken: event.replyToken ?? null,
    } : null
  }

  const { inserted } = await store.recordWebhookEvent({
    webhookEventId: event.webhookEventId, eventType: event.type,
    lineGroupId: source.type === 'group' ? source.groupId : null, eventTimestamp, isRedelivery,
  })
  // 1:1 follow or message. No messages row: messages.group_id is NOT NULL.
  if (inserted && source.type === 'user' && (event.type === 'follow' || event.type === 'message')) {
    return { kind: 'user_chat', lineUserId: source.userId, replyToken: event.replyToken ?? null }
  }
  // Every other event (room...) is only recorded. Join and leave (#52, #11), unsend (#24),
  // memberLeft and memberJoined (#29) are handled above.
  return null
}

/** #4: a file message (fileName, fileSize) or an image whose content LINE holds. An image
 *  with contentProvider.type 'external' has no content to download (only bots send those). */
function readFileMessage(message: { type: string; [k: string]: unknown }): { messageType: 'file' | 'image'; fileName: string | null; fileSize: number | null } | null {
  if (message.type === 'file') {
    return {
      messageType: 'file',
      fileName: typeof message.fileName === 'string' && message.fileName !== '' ? message.fileName : null,
      fileSize: intOrNull(message.fileSize),
    }
  }
  if (message.type === 'image') {
    const provider = (message.contentProvider as { type?: unknown } | undefined)?.type
    if (provider === 'external') return null
    return { messageType: 'image', fileName: null, fileSize: null }
  }
  return null
}

function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
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
