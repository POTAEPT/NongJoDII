import type { LineMessage } from '@/server/line/types'
import type { LinePort } from '@/server/ports'
import { AdapterError } from '@/server/log'

export class FakeLine implements LinePort {
  /** Every reply call, recorded before `failReply` is applied. */
  replies: { replyToken: string; messages: LineMessage[] }[] = []
  profileCalls: { lineGroupId: string; lineUserId: string }[] = []
  verifyCalls: string[] = []
  /** Key `${lineGroupId}:${lineUserId}` -> LINE name. A missing key answers null (LINE 404). */
  profiles = new Map<string, string>()
  /** ID token -> verified identity. A missing token answers null (LINE rejects it). */
  idTokens = new Map<string, { lineUserId: string; displayName: string | null }>()
  /** Makes reply reject, as the real adapter does on a LINE 5xx. */
  failReply = false
  /** Makes getGroupMemberProfile reject, as the real adapter does on a LINE 5xx/429. */
  failProfile = false

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    this.replies.push({ replyToken, messages })
    if (this.failReply) throw new AdapterError('line reply 500')
  }

  async getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null> {
    this.profileCalls.push({ lineGroupId, lineUserId })
    if (this.failProfile) throw new AdapterError('line profile 500')
    const displayName = this.profiles.get(`${lineGroupId}:${lineUserId}`)
    return displayName === undefined ? null : { displayName }
  }

  async verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    this.verifyCalls.push(idToken)
    const identity = this.idTokens.get(idToken)
    return identity ? { ...identity } : null
  }
}
