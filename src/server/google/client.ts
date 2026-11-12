import { AdapterError } from '../log'
import type { GooglePort, GoogleTokenResult } from '../ports'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = `openid email ${DRIVE_FILE_SCOPE}`

/** Google OAuth 2.0 web-server flow (developers.google.com/identity/protocols/oauth2/web-server).
 *  Errors carry the HTTP status only, never the response body. */
export class GoogleHttpClient implements GooglePort {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly redirectUri: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: { clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch }) {
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.redirectUri = opts.redirectUri
    // Resolve the global at call time, so a fetch replaced after construction is used.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
  }

  buildAuthUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline', // refresh_token is only returned with offline access
      prompt: 'consent', // re-consent each time, so a refresh token comes back on every sign-in
      state,
    })
    return `${AUTH_URL}?${q.toString()}`
  }

  async exchangeCode(code: string): Promise<GoogleTokenResult> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
    if (!res.ok) throw new AdapterError(`google token ${res.status}`)
    const json = (await res.json()) as { refresh_token?: unknown; scope?: unknown; id_token?: unknown }
    const claims = typeof json.id_token === 'string' ? decodeJwtPayload(json.id_token) : null
    return {
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      scopes: (typeof json.scope === 'string' ? json.scope : '').split(' ').filter(Boolean),
      subject: typeof claims?.sub === 'string' && claims.sub !== '' ? claims.sub : null,
      email: typeof claims?.email === 'string' ? claims.email : null,
    }
  }
}

/** Decodes the JWT payload WITHOUT checking its signature. That is safe only here:
 *  the id_token came straight from Google's token endpoint over TLS, in answer to a
 *  request authenticated with our client secret (Google's OpenID Connect guide,
 *  "Obtain user information from the ID token"). Never use this on a token that a
 *  client sent us. */
function decodeJwtPayload(token: string): { sub?: unknown; email?: unknown } | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return typeof payload === 'object' && payload !== null ? payload : null
  } catch {
    return null
  }
}
