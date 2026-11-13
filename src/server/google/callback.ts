import { openState, seal } from '../crypto/secretbox'
import { log } from '../log'
import { liffUrl } from '../liff-links'
import type { Defer, Deps } from '../ports'
import { DRIVE_FILE_SCOPE } from './client'
import { syncDriveForOwner } from './drive-folders'

export type CallbackOutcome = 'ok' | 'cancelled' | 'expired' | 'missing_scope' | 'no_refresh_token' | 'failed'

/** GET /api/google/callback. Trusts only a state it can open with TOKEN_ENCRYPTION_KEY.
 *
 *  Known limit (L11, accepted): the state is not bound to the browser, because
 *  sign-in starts in the LIFF webview and finishes in an external browser that
 *  shares no cookie with it. In theory a login CSRF could link a victim's Google
 *  account to an attacker's LINE user. It is bounded: the LINE user inside the
 *  state comes only from a server-verified LIFF ID token, the state expires in 10
 *  minutes, and the scope is drive.file (only files the app created). */
export async function finishGoogleSignIn(deps: Deps, params: URLSearchParams, defer: Defer): Promise<CallbackOutcome> {
  const outcome = await decide(deps, params, defer)
  log('google_signin', { outcome })
  return outcome
}

async function decide(deps: Deps, params: URLSearchParams, defer: Defer): Promise<CallbackOutcome> {
  const error = params.get('error')
  if (error !== null) return error === 'access_denied' ? 'cancelled' : 'failed'

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return 'expired'

  const opened = openState(state, deps.now(), deps.config.tokenEncryptionKey)
  if (!opened) return 'expired'

  let token
  try {
    token = await deps.google.exchangeCode(code)
  } catch {
    return 'failed'
  }
  if (!token.subject) return 'failed'
  // Granular consent lets the user untick Drive while keeping the sign-in.
  if (!token.scopes.includes(DRIVE_FILE_SCOPE)) return 'missing_scope'
  if (token.refreshToken === null) return 'no_refresh_token'

  try {
    await deps.store.upsertGoogleAccount({
      lineUserId: opened.lineUserId,
      googleSubject: token.subject,
      email: token.email,
      grantedScopes: token.scopes,
      refreshTokenCiphertext: seal(token.refreshToken, deps.config.tokenEncryptionKey),
    })
  } catch {
    return 'failed'
  }
  // #13: the Drive folders are made after the page is sent. A Drive failure is logged
  // there and never changes this outcome: the account is stored either way.
  const lineUserId = opened.lineUserId
  defer(() => syncDriveForOwner(deps, lineUserId))
  return 'ok'
}

const COPY: Record<CallbackOutcome, { h1: string; p: string }> = {
  ok: { h1: 'เชื่อม Google Drive สำเร็จ', p: 'กลับไปที่แชท LINE กับน้องจดดีได้เลย' },
  cancelled: { h1: 'ยังไม่ได้เชื่อม Google Drive', p: 'คุณยกเลิกการเข้าสู่ระบบ Google ลองใหม่ได้จากแชทกับน้องจดดี' },
  expired: { h1: 'ลิงก์หมดอายุ', p: 'กรุณาเริ่มเชื่อม Google Drive ใหม่จากแชทกับน้องจดดี' },
  missing_scope: { h1: 'ยังไม่ได้รับสิทธิ์ Google Drive', p: 'กรุณาลองใหม่และติ๊กอนุญาตให้น้องจดดีเข้าถึงไฟล์ใน Google Drive' },
  no_refresh_token: { h1: 'เชื่อม Google Drive ไม่สำเร็จ', p: 'Google ไม่ได้ส่งสิทธิ์ใช้งานต่อเนื่องมา กรุณาลองใหม่อีกครั้ง' },
  failed: { h1: 'เชื่อม Google Drive ไม่สำเร็จ', p: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งจากแชทกับน้องจดดี' },
}

/** The LIFF link the callback page sends the user back to. On a phone a
 *  liff.line.me link opens the LINE app, where GoogleView checks the status. */
export function googleReturnUrl(liffId: string): string {
  return liffUrl(liffId, 'google', 'done')
}

/** A minimal Thai page with fixed copy only: no user data. liffId comes from
 *  server config, not from the request. */
export function renderCallbackPage(outcome: CallbackOutcome, liffId: string): Response {
  const { h1, p } = COPY[outcome]
  const href = googleReturnUrl(liffId).replace(/&/g, '&amp;')
  const html =
    '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>NongJoDII</title>' +
    '<style>body{font-family:sans-serif;padding:24px;text-align:center}' +
    'a.back{display:block;margin:32px auto 0;max-width:320px;padding:16px;border-radius:12px;' +
    'background:#06C755;color:#fff;font-size:20px;font-weight:bold;text-decoration:none}</style>' +
    `</head><body><h1>${h1}</h1><p>${p}</p>` +
    `<a class="back" href="${href}">กลับไปที่ LINE</a></body></html>`
  return new Response(html, {
    status: outcome === 'ok' ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
