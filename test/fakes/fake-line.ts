import type { LineMessage } from '@/server/line/types'
import type { LinePort, LinePushResult } from '@/server/ports'
import { AdapterError, LinePushRejected } from '@/server/log'

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
    if (this.failProfile) throw new AdapterError('line profile 500')
    const displayName = this.profiles.get(`${lineGroupId}:${lineUserId}`)
    return displayName === undefined ? null : { displayName }
  }

  async getGroupMemberCount(lineGroupId: string): Promise<number> {
    if (this.failMemberCount) throw new AdapterError('line member count 500')
    return this.groupMemberCounts.get(lineGroupId) ?? 0
  }

  async getGroupSummary(lineGroupId: string): Promise<{ groupName: string } | null> {
    this.groupSummaryCalls.push(lineGroupId)
    if (this.failGroupSummary) throw new AdapterError('line group summary 500')
    const groupName = this.groupNames.get(lineGroupId)
    return groupName === undefined ? null : { groupName }
  }

  async getMessageQuota(): Promise<{ limit: number | null; used: number }> {
    if (this.failQuota) throw new AdapterError('line quota 500')
    return { ...this.quota }
  }

  async verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    this.verifyCalls.push(idToken)
    const identity = this.idTokens.get(idToken)
    return identity ? { ...identity } : null
  }
}
