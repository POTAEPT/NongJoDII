import type { LineMessage } from '@/server/line/types'
import type { LinePort, LinePushResult } from '@/server/ports'
import { AdapterError, LinePushRejected } from '@/server/log'
import type { FakeClock } from './fake-google'

export class FakeLine implements LinePort {
  /** Every reply call, recorded before `failReply` is applied. */
  replies: { replyToken: string; messages: LineMessage[] }[] = []
  /** Every push call with its retry key, recorded before `failPush` is applied. */
  pushes: { to: string; messages: LineMessage[]; retryKey?: string }[] = []
  profileCalls: { lineGroupId: string; lineUserId: string }[] = []
  verifyCalls: string[] = []
  /** Key `${lineGroupId}:${lineUserId}` -> LINE name. A missing key answers null (LINE 404). */
  profiles = new Map<string, string>()
  /** ID token -> verified identity. A missing token answers null (LINE rejects it). */
  idTokens = new Map<string, { lineUserId: string; displayName: string | null }>()
  /** Push budget getMessageQuota answers with; limit null = no limit. */
  quota: { limit: number | null; used: number } = { limit: 300, used: 0 }
  failQuota = false
  /** lineGroupId -> LINE's member count. A missing key answers 0. */
  groupMemberCounts = new Map<string, number>()
  failMemberCount = false
  /** lineGroupId -> LINE group name. A missing key answers null (LINE 404). */
  groupNames = new Map<string, string>()
  failGroupSummary = false
  groupSummaryCalls: string[] = []
  /** How long getGroupSummary takes on `clock` (#13 time limit); 0 (the default) = instant. */
  groupSummaryMs = 0
  clock: FakeClock | null = null
  /** Makes reply reject, as the real adapter does on a LINE 5xx. */
  failReply = false
  /** Makes push reject as the real adapter does on a LINE 5xx: the outcome is unknown to
   *  the caller, and here LINE did not accept the push (the retry key stays free). */
  failPush = false
  /** Makes push reject as the real adapter does on a LINE 4xx (LinePushRejected): LINE
   *  refused the push, nothing was sent. */
  rejectPush = false
  /** Makes getGroupMemberProfile reject, as the real adapter does on a LINE 5xx/429. */
  failProfile = false
  /** When above 0, getGroupMemberProfile answers only after this many ms, then rejects
   *  as the real adapter does when its timeout cuts a slow LINE call. */
  slowProfileMs = 0
  /** How long getGroupMemberProfile takes on `clock` (#32 time limit); 0 (the default) = instant. */
  profileMs = 0
  /** `${lineGroupId}:${lineUserId}` keys whose getGroupMemberProfile rejects, as on a LINE 5xx. */
  failProfileFor = new Set<string>()

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    this.replies.push({ replyToken, messages })
    if (this.failReply) throw new AdapterError('line reply 500')
  }

  /** Retry keys LINE has accepted: a repeat sends nothing and resolves 'duplicate' (LINE answers 409). */
  acceptedRetryKeys = new Set<string>()
  /** Pushes LINE actually delivered (a repeat of an accepted retry key is not one). */
  delivered: { to: string; messages: LineMessage[]; retryKey?: string }[] = []
  /** LINE accepts and delivers the push, then the answer is lost (a timeout): the outcome
   *  is unknown to the caller, and the retry key counts as accepted for a later repeat. */
  timeoutAfterAccept = false

  async push(to: string, messages: LineMessage[], opts?: { retryKey?: string }): Promise<LinePushResult> {
    this.pushes.push({ to, messages, retryKey: opts?.retryKey })
    if (this.rejectPush) throw new LinePushRejected(400)
    if (this.failPush) throw new AdapterError('line push 500')
    const key = opts?.retryKey
    if (key !== undefined && this.acceptedRetryKeys.has(key)) return 'duplicate'
    if (key !== undefined) this.acceptedRetryKeys.add(key)
    this.delivered.push({ to, messages, retryKey: key })
    if (this.timeoutAfterAccept) throw new AdapterError('line timeout')
    return 'sent'
  }

  async getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null> {
    this.profileCalls.push({ lineGroupId, lineUserId })
    if (this.slowProfileMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.slowProfileMs))
      throw new AdapterError('line timeout')
    }
    if (this.profileMs > 0) this.clock?.advance(this.profileMs)
    if (this.failProfile || this.failProfileFor.has(`${lineGroupId}:${lineUserId}`)) throw new AdapterError('line profile 500')
    const displayName = this.profiles.get(`${lineGroupId}:${lineUserId}`)
    return displayName === undefined ? null : { displayName }
  }

  async getGroupMemberCount(lineGroupId: string): Promise<number> {
    if (this.failMemberCount) throw new AdapterError('line member count 500')
    return this.groupMemberCounts.get(lineGroupId) ?? 0
  }

  async getGroupSummary(lineGroupId: string): Promise<{ groupName: string } | null> {
    this.groupSummaryCalls.push(lineGroupId)
    if (this.groupSummaryMs > 0) this.clock?.advance(this.groupSummaryMs)
    if (this.failGroupSummary) throw new AdapterError('line group summary 500')
    const groupName = this.groupNames.get(lineGroupId)
    return groupName === undefined ? null : { groupName }
  }

  async getMessageQuota(): Promise<{ limit: number | null; used: number }> {
    if (this.failQuota) throw new AdapterError('line quota 500')
    return { ...this.quota }
  }

  // ---- #4 content download ----
  /** LINE message id -> its content. A missing id answers null (LINE 404). */
  contents = new Map<string, { data: Uint8Array; contentType: string | null }>()
  /** Every content download, with the timeout it was given. */
  contentCalls: { messageId: string; timeoutMs: number }[] = []
  /** How long a download takes on `clock`; 0 = instant. A download longer than its
   *  timeout rejects at the timeout, as the real adapter does. */
  contentMs = 0
  failContent = false

  async getMessageContent(messageId: string, opts: { timeoutMs: number }): Promise<{ data: Uint8Array; contentType: string | null } | null> {
    this.contentCalls.push({ messageId, timeoutMs: opts.timeoutMs })
    if (this.contentMs > opts.timeoutMs) {
      this.clock?.advance(opts.timeoutMs)
      throw new AdapterError('line timeout')
    }
    if (this.contentMs > 0) this.clock?.advance(this.contentMs)
    if (this.failContent) throw new AdapterError('line content 500')
    const c = this.contents.get(messageId)
    return c ? { data: c.data, contentType: c.contentType } : null
  }

  /** Every leaveGroup call (#11), recorded before failLeave / leaveNotInGroup apply. */
  leaveCalls: string[] = []
  /** Makes leaveGroup reject, as the real adapter does on a LINE 5xx or a timeout. */
  failLeave = false
  /** Makes leaveGroup answer 'not_in_group' (LINE 404). */
  leaveNotInGroup = false
  /** How long leaveGroup takes on `clock` (#30 part B time limit); 0 (the default) = instant. */
  leaveMs = 0
  /** LINE group IDs whose leaveGroup rejects (a LINE 5xx for those groups only). */
  failLeaveFor = new Set<string>()

  async leaveGroup(lineGroupId: string): Promise<'left' | 'not_in_group'> {
    this.leaveCalls.push(lineGroupId)
    if (this.leaveMs > 0) this.clock?.advance(this.leaveMs)
    if (this.failLeave || this.failLeaveFor.has(lineGroupId)) throw new AdapterError('line leave 500')
    return this.leaveNotInGroup ? 'not_in_group' : 'left'
  }

  async verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    this.verifyCalls.push(idToken)
    const identity = this.idTokens.get(idToken)
    return identity ? { ...identity } : null
  }
}
