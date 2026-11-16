import { randomUUID } from 'node:crypto'
import type { LineMessage } from '@/server/line/types'
import { AdapterError, ContentTooLarge, LinePushRejected } from '@/server/log'
import type { LinePort, LinePushResult } from '@/server/ports'
import { DEMO_TOKEN_PREFIX, type DemoWorld } from './world'

/** The demo's LINE: nothing leaves the process. Replies and pushes become bot chat items;
 *  profiles, the member count and the group name come from the demo personas and groups.
 *  Each lands in the chat of the group it targets (the reply token's group, the push `to`).
 *  Only this port accepts `demo:<lineUserId>` ID tokens; the production composition
 *  (src/server/deps.ts) never builds it. */
export class DemoLine implements LinePort {
  private readonly usedReplyTokens = new Set<string>()
  private readonly acceptedRetryKeys = new Set<string>()

  constructor(private readonly world: DemoWorld) {}

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    // LINE accepts a reply token once.
    if (this.usedReplyTokens.has(replyToken)) {
      this.world.addLog('error', `reply refused: token ${replyToken} already used`)
      throw new AdapterError('line reply 400')
    }
    this.usedReplyTokens.add(replyToken)
    // The reply lands in the group whose event carried the token.
    const id = this.world.replyTokens.get(replyToken)
    const group = (id ? this.world.groupById(id) : undefined) ?? this.world.group
    for (const message of messages) this.world.addChat({ from: 'bot', via: 'reply', message }, group)
    this.world.addLog('reply', `reply to ${group.name}, ${messages.length} message(s): ${describe(messages)}`)
  }

  async push(to: string, messages: LineMessage[], opts?: { retryKey?: string }): Promise<LinePushResult> {
    const key = opts?.retryKey
    if (key !== undefined && this.acceptedRetryKeys.has(key)) {
      this.world.addLog('push', `push duplicate (retry key ${key}): nothing sent`)
      return 'duplicate'
    }
    const person = this.world.personaById(to)
    if (person) {
      // A 1:1 push (#120: the Owner's weekly card). LINE counts it once.
      const { limit, used } = this.world.quota
      if (limit !== null && used + 1 > limit) {
        this.world.addLog('error', `push refused: quota ${used}/${limit}, this push costs 1`)
        throw new LinePushRejected(429)
      }
      if (key !== undefined) this.acceptedRetryKeys.add(key)
      this.world.quota.used += 1
      const thread = this.world.direct.get(person.key) ?? []
      for (const message of messages) {
        thread.push({ id: randomUUID(), at: this.world.now().toISOString(), from: 'bot', via: 'push', message })
      }
      this.world.direct.set(person.key, thread)
      this.world.addLog('push', `1:1 push to ${person.lineName}, ${messages.length} message(s), cost 1: ${describe(messages)}`)
      return 'sent'
    }
    const group = this.world.groupById(to)
    if (!group || !group.botInGroup) {
      this.world.addLog('error', `push refused: bot is not in ${to}`)
      throw new LinePushRejected(400)
    }
    // LINE counts a group push once per member, per push call.
    const cost = this.world.membersInGroup(group).length
    const { limit, used } = this.world.quota
    if (limit !== null && used + cost > limit) {
      this.world.addLog('error', `push refused: quota ${used}/${limit}, this push costs ${cost}`)
      throw new LinePushRejected(429)
    }
    if (key !== undefined) this.acceptedRetryKeys.add(key)
    this.world.quota.used += cost
    for (const message of messages) this.world.addChat({ from: 'bot', via: 'push', message }, group)
    this.world.addLog('push', `push to ${group.name}, ${messages.length} message(s), cost ${cost}: ${describe(messages)}`)
    return 'sent'
  }

  async getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null> {
    const group = this.world.groupById(lineGroupId)
    const p = this.world.personaById(lineUserId)
    return group && p && group.members.has(p.key) ? { displayName: p.lineName } : null
  }

  async getGroupMemberCount(lineGroupId: string): Promise<number> {
    const group = this.world.groupById(lineGroupId)
    return group ? this.world.membersInGroup(group).length : 0
  }

  async getGroupSummary(lineGroupId: string): Promise<{ groupName: string } | null> {
    const group = this.world.groupById(lineGroupId)
    if (!group || !group.botInGroup) return null
    return { groupName: group.name }
  }

  async verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    if (!idToken.startsWith(DEMO_TOKEN_PREFIX)) return null
    const p = this.world.personaById(idToken.slice(DEMO_TOKEN_PREFIX.length))
    return p ? { lineUserId: p.lineUserId, displayName: p.lineName } : null
  }

  async getMessageQuota(): Promise<{ limit: number | null; used: number }> {
    return { ...this.world.quota }
  }

  async getMessageContent(
    messageId: string, opts: { timeoutMs: number; maxBytes: number },
  ): Promise<{ data: Uint8Array; contentType: string | null } | null> {
    const c = this.world.contents.get(messageId)
    if (!c) return null
    if (c.data.byteLength > opts.maxBytes) throw new ContentTooLarge()
    return { data: c.data, contentType: c.contentType }
  }

  async leaveGroup(lineGroupId: string): Promise<'left' | 'not_in_group'> {
    const group = this.world.groupById(lineGroupId)
    if (!group || !group.botInGroup) return 'not_in_group'
    group.botInGroup = false
    this.world.system('NongJoDII ออกจากกลุ่มแล้ว', group)
    this.world.addLog('event', `bot left ${group.name} (leaveGroup)`)
    return 'left'
  }
}

function describe(messages: LineMessage[]): string {
  return messages
    .map((m) => (m.type === 'text' ? `text "${m.text.slice(0, 60)}"` : `${m.type} "${m.altText.slice(0, 60)}"`))
    .join(', ')
}
