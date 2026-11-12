import type { LineMessage } from '@/server/line/types'
import type { LinePort } from '@/server/ports'
import { AdapterError } from '@/server/log'

export class FakeLine implements LinePort {
  /** Every reply call, recorded before `failReply` is applied. */
  replies: { replyToken: string; messages: LineMessage[] }[] = []
  /** Every push call, recorded before `failPush` is applied. */
  pushes: { to: string; messages: LineMessage[] }[] = []
  profileCalls: { lineGroupId: string; lineUserId: string }[] = []
  verifyCalls: string[] = []
  /** Key `${lineGroupId}:${lineUserId}` -> LINE name. A missing key answers null (LINE 404). */
  profiles = new Map<string, string>()
  /** ID token -> verified identity. A missing token answers null (LINE rejects it). */
  idTokens = new Map<string, { lineUserId: string; displayName: string | null }>()
  /** Push budget getMessageQuota answers with; limit null = no limit. */
  quota: { limit: number | null; used: number } = { limit: 300, used: 0 }
  failQuota = false
  /** Makes reply reject, as the real adapter does on a LINE 5xx. */
  failReply = false
  /** Makes push reject, as the real adapter does on a LINE 5xx or 429. */
  failPush = false
  /** Makes getGroupMemberProfile reject, as the real adapter does on a LINE 5xx/429. */
  failProfile = false
  /** When above 0, getGroupMemberProfile answers only after this many ms, then rejects
   *  as the real adapter does when its timeout cuts a slow LINE call. */
  slowProfileMs = 0

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    this.replies.push({ replyToken, messages })
    if (this.failReply) throw new AdapterError('line reply 500')
  }

  async push(to: string, messages: LineMessage[]): Promise<void> {
    this.pushes.push({ to, messages })
    if (this.failPush) throw new AdapterError('line push 500')
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
