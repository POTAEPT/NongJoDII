import { AdapterError, GoogleTokenRevoked } from '../log'
import type { DriveFolderState, GooglePort, GoogleTokenResult } from '../ports'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = `openid email ${DRIVE_FILE_SCOPE}`
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

/** Google OAuth 2.0 web-server flow (developers.google.com/identity/protocols/oauth2/web-server).
 *  Errors carry the HTTP status only, never the response body. */
export class GoogleHttpClient implements GooglePort {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly redirectUri: string
  private readonly fetchImpl: typeof fetch

  private readonly timeoutMs: number

  constructor(opts: {
    clientId: string; clientSecret: string; redirectUri: string; fetchImpl?: typeof fetch; timeoutMs?: number
  }) {
    this.clientId = opts.clientId
    this.clientSecret = opts.clientSecret
    this.redirectUri = opts.redirectUri
    // Resolve the global at call time, so a fetch replaced after construction is used.
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args))
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  /** Drive and refresh calls run inside after(), several per sign-in: each is cut at
   *  10 s so they fit the route's time limit. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') throw new AdapterError('google timeout')
      throw err
    }
  }

  buildAuthUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline', // refresh_token is only returned with offline access
      // select_account (#14): the account chooser always comes first, so the browser's
      // default Google account is never signed in without the person picking it.
      // consent: re-consent each time, so a refresh token comes back on every sign-in.
      prompt: 'select_account consent',
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

  /** developers.google.com/identity/protocols/oauth2/web-server#offline */
  async accessToken(refreshToken: string): Promise<string> {
    const res = await this.call(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null
      if (res.status === 400 && body?.error === 'invalid_grant') throw new GoogleTokenRevoked()
      throw new AdapterError(`google refresh ${res.status}`)
    }
    const json = (await res.json()) as { access_token?: unknown }
    if (typeof json.access_token !== 'string' || json.access_token === '') {
      throw new AdapterError('google refresh no access_token')
    }
    return json.access_token
  }

  /** files.create with the folder MIME type (developers.google.com/drive/api/guides/folder). */
  async createFolder(accessToken: string, name: string, parentId: string | null): Promise<string> {
    const meta: { name: string; mimeType: string; parents?: string[] } = { name, mimeType: FOLDER_MIME }
    if (parentId !== null) meta.parents = [parentId]
    const res = await this.call(`${DRIVE_FILES}?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    })
    if (!res.ok) throw new AdapterError(`google drive create ${res.status}`)
    const json = (await res.json()) as { id?: unknown }
    if (typeof json.id !== 'string' || json.id === '') throw new AdapterError('google drive create no id')
    return json.id
  }

  /** files.get returns only a few fields by default, so `trashed` is asked for. */
  async getFolder(accessToken: string, folderId: string): Promise<DriveFolderState> {
    const res = await this.call(`${DRIVE_FILES}/${encodeURIComponent(folderId)}?fields=id,trashed`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res.status === 404) return 'missing'
    if (!res.ok) throw new AdapterError(`google drive get ${res.status}`)
    const json = (await res.json()) as { trashed?: unknown }
    return json.trashed === true ? 'trashed' : 'ok'
  }

  async shareAnyoneReader(accessToken: string, fileId: string): Promise<void> {
    const res = await this.call(`${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions?fields=id`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    })
    if (!res.ok) throw new AdapterError(`google drive share ${res.status}`)
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
