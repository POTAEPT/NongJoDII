import { AdapterError, DriveShareRefused, GoogleTokenRevoked } from '../log'
import type { DriveFolderState, DriveUpload, GooglePort, GoogleTokenResult } from '../ports'

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const SCOPE = `openid email ${DRIVE_FILE_SCOPE}`
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
/** Drive's guide: multipart for 5 MB or less, resumable above. */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024
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
  private async call(url: string, init: RequestInit, timeoutMs: number = this.timeoutMs): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
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

  /** #82, developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke: POST the
   *  token form-encoded; 200 = revoked. A 400 means Google no longer holds the grant (already
   *  revoked or expired), which leaves the same state. Only the status is read. */
  async revokeToken(refreshToken: string): Promise<'revoked' | 'invalid'> {
    const res = await this.call(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    })
    if (res.ok) return 'revoked'
    if (res.status === 400) return 'invalid'
    throw new AdapterError(`google revoke ${res.status}`)
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
    if (res.ok) return
    // #4 follow-up: only an explicit sharing-policy reason is a refusal (Drive's "Resolve
    // errors" guide and error reasons): 400 invalidSharingRequest ("ACL change not allowed"),
    // and the domain and sharing policy reasons below. Everything else (rate limits, which
    // are 403 too, an empty body, a bare "forbidden", a 5xx) is unknown: retrying may help,
    // and no Owner card is sent. Only the reason is read; the body is never logged.
    const reasons = await errorReasons(res)
    if (reasons.some((r) => SHARE_POLICY_REASONS.has(r))) throw new DriveShareRefused(res.status)
    throw new AdapterError(`google drive share ${res.status}`)
  }

  /** permissions.list: whether the folder has an "anyone" permission (link sharing).
   *  Permission IDs are opaque (Permission resource), so the type is read instead. */
  async folderShared(accessToken: string, folderId: string): Promise<boolean> {
    const res = await this.call(`${DRIVE_FILES}/${encodeURIComponent(folderId)}/permissions?fields=permissions(type,role)`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new AdapterError(`google drive permissions ${res.status}`)
    const json = (await res.json()) as { permissions?: unknown }
    return Array.isArray(json.permissions) &&
      json.permissions.some((p) => (p as { type?: unknown } | null)?.type === 'anyone')
  }

  /** #4 (developers.google.com/drive/api/guides/manage-uploads). Up to 5 MB one multipart
   *  request; above, a resumable session (one POST for the session, one PUT with every
   *  byte). The whole upload shares `timeoutMs`. No sharing call: the file inherits the
   *  Project folder's "anyone with the link" permission (#13). */
  async uploadFile(accessToken: string, f: DriveUpload, opts: { timeoutMs: number }): Promise<{ id: string; webViewLink: string }> {
    const end = Date.now() + opts.timeoutMs
    const left = () => end - Date.now()
    const meta = JSON.stringify({ name: f.name, parents: [f.parentId], mimeType: f.mimeType })
    const fields = 'fields=id,webViewLink'
    let res: Response
    if (f.data.byteLength <= MULTIPART_MAX_BYTES) {
      const boundary = `nongjodii-${crypto.randomUUID()}`
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
        `--${boundary}\r\nContent-Type: ${f.mimeType}\r\n\r\n`, f.data as Uint8Array<ArrayBuffer>, `\r\n--${boundary}--`,
      ])
      res = await this.call(`${DRIVE_UPLOAD}?uploadType=multipart&${fields}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      }, left())
    } else {
      const session = await this.call(`${DRIVE_UPLOAD}?uploadType=resumable&${fields}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': f.mimeType, 'X-Upload-Content-Length': String(f.data.byteLength),
        },
        body: meta,
      }, left())
      const location = session.headers.get('location')
      if (!session.ok || !location) throw new AdapterError(`google drive upload session ${session.status}`)
      res = await this.call(location, {
        method: 'PUT', headers: { 'Content-Type': f.mimeType }, body: new Blob([f.data as Uint8Array<ArrayBuffer>]),
      }, left())
    }
    if (!res.ok) throw new AdapterError(`google drive upload ${res.status}`)
    const json = (await res.json()) as { id?: unknown; webViewLink?: unknown }
    if (typeof json.id !== 'string' || json.id === '') throw new AdapterError('google drive upload no id')
    const webViewLink = typeof json.webViewLink === 'string' && json.webViewLink !== ''
      ? json.webViewLink
      : `https://drive.google.com/file/d/${encodeURIComponent(json.id)}/view`
    return { id: json.id, webViewLink }
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

/** Drive error reasons that mean a sharing policy forbids the "anyone with the link"
 *  permission: the Workspace admin's settings, not a passing condition. Matched by reason
 *  whatever the status: Drive answers some of them with 400 and some with 403. The list is
 *  partly drawn from community reports, not only Google's docs: invalidSharingRequest and
 *  domainPolicy are in the "Resolve errors" guide; shareOutNotPermittedForContent (a 400,
 *  rclone forum) and publishOutNotPermitted (a 400 when a Workspace blocks public sharing,
 *  gogcli issue 675) come from reports of real answers. */
const SHARE_POLICY_REASONS = new Set([
  'invalidSharingRequest', 'domainPolicy', 'shareOutNotPermitted', 'shareOutNotPermittedForContent',
  'shareInNotPermitted', 'publishOutNotPermitted', 'teamDriveDomainUsersOnlyRestriction',
  'cannotShareTeamDriveWithNonGoogleAccounts',
])

/** The `reason` of each entry in a Google API error body (error.errors[]). */
async function errorReasons(res: Response): Promise<string[]> {
  const body = (await res.json().catch(() => null)) as { error?: { errors?: unknown } } | null
  const errors = body?.error?.errors
  if (!Array.isArray(errors)) return []
  return errors.map((e) => {
    const r = (e as { reason?: unknown } | null)?.reason
    return typeof r === 'string' ? r : ''
  })
}
