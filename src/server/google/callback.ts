import { openState, seal } from '../crypto/secretbox'
import { log, logError } from '../log'
import { GOOGLE_RETURN, liffUrl } from '../liff-links'
import type { Defer, Deps } from '../ports'
import { completePendingOwnerChanges } from '../setup/owner-change'
import { retireOtherAccountConnections } from './change-account'
import { DRIVE_FILE_SCOPE } from './client'
import { driveDeadline, syncDriveForOwner } from './drive-folders'

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
  // The route's 60 s cover this handler and its after() work, so the Drive work is timed
  // from here.
  const deadline = driveDeadline(deps.now())
  const outcome = await decide(deps, params, defer, deadline)
  log('google_signin', { outcome })
  return outcome
}

async function decide(deps: Deps, params: URLSearchParams, defer: Defer, deadline: Date): Promise<CallbackOutcome> {
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

  const lineUserId = opened.lineUserId
  try {
    const { id } = await deps.store.upsertGoogleAccount({
      lineUserId,
      googleSubject: token.subject,
      email: token.email,
      grantedScopes: token.scopes,
      refreshTokenCiphertext: seal(token.refreshToken, deps.config.tokenEncryptionKey),
      signedInAt: deps.now(),
    })
    // #14: only a sign-in started from the "change Google account" action (the intent is
    // sealed in the state) may move a Project to another Google account. Any other sign-in
    // with another account retires nothing: the status then reports the Project as still
    // connected to another account and the page offers the change. The Owner role is
    // checked again here, as retireOtherAccountConnections reads the confirmed Owner's
    // Projects now. Done before the page is answered, so a failure shows as 'failed' and
    // the Owner tries again; a repeat finishes what was left.
    if (opened.change) await retireOtherAccountConnections(deps, lineUserId, id)
    // #30: a nominee of a group whose Owner left now has the Drive connection the change
    // waits for, so it takes effect here (repeatable: a retry after 'failed' finishes it).
    await completePendingOwnerChanges(deps, lineUserId, defer)
  } catch (err) {
    logError('google_signin_store_failed', {}, err)
    return 'failed'
  }
  // #13: the Drive folders are made after the page is sent. A Drive failure is logged
  // there and never changes this outcome: the account is stored either way.
  defer(() => syncDriveForOwner(deps, lineUserId, deadline))
  return 'ok'
}

const COPY: Record<CallbackOutcome, { h1: string; p: string }> = {
  ok: { h1: 'เชื่อม Google Drive สำเร็จ', p: 'กลับไปที่แชต LINE กับน้องจดดีได้เลย' },
  cancelled: { h1: 'ยังไม่ได้เชื่อม Google Drive', p: 'คุณยกเลิกการเข้าสู่ระบบ Google ลองใหม่ได้จากแชตกับน้องจดดี' },
  expired: { h1: 'ลิงก์หมดอายุ', p: 'กรุณาเริ่มเชื่อม Google Drive ใหม่จากแชตกับน้องจดดี' },
  missing_scope: { h1: 'ยังไม่ได้รับสิทธิ์ Google Drive', p: 'กรุณาลองใหม่และติ๊กอนุญาตให้น้องจดดีเข้าถึงไฟล์ใน Google Drive' },
  no_refresh_token: { h1: 'เชื่อม Google Drive ไม่สำเร็จ', p: 'Google ไม่ได้ส่งสิทธิ์ใช้งานต่อเนื่องมา กรุณาลองใหม่อีกครั้ง' },
  failed: { h1: 'เชื่อม Google Drive ไม่สำเร็จ', p: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งจากแชตกับน้องจดดี' },
}

/** The LIFF link the callback page sends the user back to. On a phone a
 *  liff.line.me link opens the LINE app, where GoogleView checks the status. Only 'ok'
 *  returns as done (#14): after a cancelled or failed change of account the old account
 *  is still connected, and the view must not greet that as a finished sign-in. */
export function googleReturnUrl(liffId: string, outcome: CallbackOutcome): string {
  return liffUrl(liffId, 'google', outcome === 'ok' ? GOOGLE_RETURN.done : GOOGLE_RETURN.back)
}

/** A minimal Thai page with fixed copy only: no user data. liffId comes from
 *  server config, not from the request. */
export function renderCallbackPage(outcome: CallbackOutcome, liffId: string): Response {
  const { h1, p } = COPY[outcome]
  const href = googleReturnUrl(liffId, outcome).replace(/&/g, '&amp;')
  const ok = outcome === 'ok'
  // Figma UI v4 #11 ผลลัพธ์: brand app bar, a status circle, the copy and one primary button.
  const icon = ok
    ? '<path d="M20 6L9 17l-5-5"/>'
    : '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
  const html =
    '<!doctype html><html lang="th"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>น้องจดดี</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">' +
    '<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;' +
    "font-family:'IBM Plex Sans Thai',sans-serif;background:#F4F6F9;color:#12294D}" +
    'header{background:#12294D;color:#fff;font-weight:600;font-size:16px;padding:16px}' +
    'main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center}' +
    '.badge{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center}' +
    '.ok{background:#DDF3E8;color:#2E9E6B}.bad{background:#FEF3C7;color:#D97706}' +
    'h1{font-size:20px;font-weight:600;margin:16px 0 8px}p{margin:0;font-size:14px;color:#545454;max-width:320px}' +
    'footer{background:#fff;border-top:1px solid #D5E2F3;padding:12px 16px 24px}' +
    'a.back{display:block;padding:14px;border-radius:12px;background:#1F5FB0;color:#fff;font-size:16px;' +
    'font-weight:600;text-align:center;text-decoration:none}</style>' +
    '</head><body><header>เชื่อม Google Drive</header><main>' +
    `<div class="badge ${ok ? 'ok' : 'bad'}"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>` +
    `<h1>${h1}</h1><p>${p}</p></main>` +
    `<footer><a class="back" href="${href}">กลับไปที่ LINE</a></footer></body></html>`
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}
