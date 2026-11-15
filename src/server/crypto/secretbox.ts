import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM for the Google refresh token (stored in the text column
// google_accounts.refresh_token_ciphertext) and the OAuth state.

/** Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>. Key: 32 bytes. */
export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/** null when the input is malformed, tampered with, or sealed with another key. */
export function open(sealed: string, key: Buffer): string | null {
  const [v, iv, tag, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || ct === undefined) return null
  try {
    const tagBuf = Buffer.from(tag, 'base64url')
    if (tagBuf.length !== 16) return null // state is attacker-supplied: reject short tags
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: 16 })
    d.setAuthTag(tagBuf)
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

const STATE_PURPOSE = 'google_oauth'

type StatePayload = { p: string; u: string; exp: number; c?: boolean }

const STATE_TTL_MS = 10 * 60_000

/** OAuth state: sealed JSON {p:'google_oauth', u:lineUserId, exp:ms, c?:true}. Sealing gives
 *  integrity and hides the user ID. `change` (#14, stored as c) says the sign-in was started
 *  from the "change Google account" action: only such a sign-in may retire a Drive
 *  connection, and the server sets it, never the browser. */
export function sealState(lineUserId: string, now: Date, key: Buffer, opts?: { change?: boolean }): string {
  const payload: StatePayload = { p: STATE_PURPOSE, u: lineUserId, exp: now.getTime() + STATE_TTL_MS }
  if (opts?.change === true) payload.c = true
  return seal(JSON.stringify(payload), key)
}

/** null if bad, wrong p, or exp <= now. change is true only for a sealed c === true. */
export function openState(state: string, now: Date, key: Buffer): { lineUserId: string; change: boolean } | null {
  const json = open(state, key)
  if (json === null) return null
  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const { p, u, exp, c } = payload as Partial<StatePayload>
  if (p !== STATE_PURPOSE || typeof u !== 'string' || u === '' || typeof exp !== 'number') return null
  if (exp <= now.getTime()) return null
  return { lineUserId: u, change: c === true }
}
