import { AdapterError } from '../log'
import type { LinePort } from '../ports'
import type { LineMessage } from './types'

const API = 'https://api.line.me'

/** LINE Messaging API (reply, push, quota, group member profile) and LINE Login ID token verify.
 *  Errors carry the HTTP status only, never the response body. */
export class LineHttpClient implements LinePort {
  private readonly token: string
  private readonly loginChannelId: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: { channelAccessToken: string; loginChannelId: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    this.token = opts.channelAccessToken
    this.loginChannelId = opts.loginChannelId
    // Resolve the global at call time, so a fetch replaced after construction is used.
    const fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    // Every LINE call is cut at 10 s, so a slow LINE answer cannot use up the webhook
    // route's 60 s budget (a Summary's model call takes up to 45 s of it).
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.fetchImpl = (async (input, init) => {
      try {
        return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
      } catch (err) {
        const name = (err as { name?: unknown } | null)?.name
        if (name === 'TimeoutError' || name === 'AbortError') throw new AdapterError('line timeout')
        throw err
      }
    }) as typeof fetch
  }

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    const res = await this.fetchImpl(`${API}/v2/bot/message/reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToken, messages }),
    })
    if (!res.ok) throw new AdapterError(`line reply ${res.status}`)
  }

  /** With a retry key, LINE accepts the push at most once per key (24 h): a repeat
   *  answers 409, which means it was already sent, so it counts as success. */
  async push(to: string, messages: LineMessage[], opts?: { retryKey?: string }): Promise<void> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }
    if (opts?.retryKey) headers['X-Line-Retry-Key'] = opts.retryKey
    const res = await this.fetchImpl(`${API}/v2/bot/message/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, messages }),
    })
    if (res.status === 409 && opts?.retryKey) return
    if (!res.ok) throw new AdapterError(`line push ${res.status}`)
  }

  async getGroupMemberProfile(lineGroupId: string, lineUserId: string): Promise<{ displayName: string } | null> {
    const url = `${API}/v2/bot/group/${encodeURIComponent(lineGroupId)}/member/${encodeURIComponent(lineUserId)}`
    const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } })
    if (res.status === 404) return null
    if (res.status !== 200) throw new AdapterError(`line profile ${res.status}`)
    const body = (await res.json()) as { displayName?: unknown }
    if (typeof body.displayName !== 'string') throw new AdapterError('line profile 200')
    return { displayName: body.displayName }
  }

  async getGroupMemberCount(lineGroupId: string): Promise<number> {
    const url = `${API}/v2/bot/group/${encodeURIComponent(lineGroupId)}/members/count`
    const res = await this.fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } })
    if (res.status !== 200) throw new AdapterError(`line member count ${res.status}`)
    const body = (await res.json()) as { count?: unknown }
    if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 0) {
      throw new AdapterError('line member count 200')
    }
    return body.count
  }

  async getMessageQuota(): Promise<{ limit: number | null; used: number }> {
    const headers = { Authorization: `Bearer ${this.token}` }
    const [quota, usage] = await Promise.all([
      this.fetchImpl(`${API}/v2/bot/message/quota`, { method: 'GET', headers }),
      this.fetchImpl(`${API}/v2/bot/message/quota/consumption`, { method: 'GET', headers }),
    ])
    if (!quota.ok) throw new AdapterError(`line quota ${quota.status}`)
    if (!usage.ok) throw new AdapterError(`line quota consumption ${usage.status}`)
    const q = (await quota.json()) as { type?: unknown; value?: unknown }
    const u = (await usage.json()) as { totalUsage?: unknown }
    if (typeof u.totalUsage !== 'number') throw new AdapterError('line quota consumption 200')
    if (q.type === 'none') return { limit: null, used: u.totalUsage }
    if (q.type !== 'limited' || typeof q.value !== 'number') throw new AdapterError('line quota 200')
    return { limit: q.value, used: u.totalUsage }
  }

  /** LINE checks the signature, aud (= the LINE Login channel ID) and exp. */
  async verifyIdToken(idToken: string): Promise<{ lineUserId: string; displayName: string | null } | null> {
    const res = await this.fetchImpl(`${API}/oauth2/v2.1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: this.loginChannelId }).toString(),
    })
    if (res.status === 400) return null
    if (res.status !== 200) throw new AdapterError(`line verify ${res.status}`)
    const body = (await res.json()) as { sub?: unknown; name?: unknown }
    // A 200 without a usable sub gives no identity: treat it as rejected.
    if (typeof body.sub !== 'string' || body.sub === '') return null
    return { lineUserId: body.sub, displayName: typeof body.name === 'string' ? body.name : null }
  }
}
