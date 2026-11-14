import { GOOGLE_RETURN } from '@/server/liff-links'

/** Result of POST /api/google/status as seen by the LIFF page. 'sign_in_again': the
 *  person has a Google account here, but Google no longer accepts its grant (#14). */
export type GoogleStatus = 'connected' | 'sign_in_again' | 'not_connected' | 'unauthorized' | 'failed'

export type GoogleStatusResult = {
  status: GoogleStatus
  /** The person may change the connected Google account: a confirmed Owner (#14). */
  canChange: boolean
  /** When their latest Google sign-in finished (ISO), or null. It moves on every sign-in. */
  signedInAt: string | null
}

/** What the view's `id` says about this visit (GOOGLE_RETURN, set by the OAuth callback
 *  page). returning: a sign-in has just ended, so none starts by itself. signedIn: it
 *  finished, so a connected status is greeted as a success. */
export function returnVisit(id: string | null): { returning: boolean; signedIn: boolean } {
  return { returning: id === GOOGLE_RETURN.done || id === GOOGLE_RETURN.back, signedIn: id === GOOGLE_RETURN.done }
}

export type OpenPhase = 'connected' | 'sign_in_again' | 'not_connected' | 'unauthorized' | 'failed' | 'start'
export type ReturnPhase = 'connected' | 'unauthorized' | 'failed'

/** Where GoogleView goes on its first load. 'start' = begin sign-in at once: only for a
 *  person with no Google account, and not on the return visit from the callback page
 *  (`returning`), where a sign-in has just ended. */
export function phaseOnOpen(result: GoogleStatusResult, returning: boolean): OpenPhase {
  if (result.status === 'not_connected') return returning ? 'not_connected' : 'start'
  return result.status
}

/** Where GoogleView goes when the user comes back to LINE while sign-in is open in the
 *  external browser. null = stay in 'opened' (sign-in not finished yet). `knownSignedInAt`
 *  is the sign-in time the page saw before this sign-in started: during a change of
 *  account the old account is still connected, so only a newer sign-in counts as done. */
export function phaseOnReturn(result: GoogleStatusResult, knownSignedInAt: string | null): ReturnPhase | null {
  switch (result.status) {
    case 'connected':
      return result.signedInAt !== knownSignedInAt ? 'connected' : null
    case 'unauthorized':
      return 'unauthorized' // LINE rejected the saved token: reopen from the chat
    case 'failed':
      return 'failed' // the status request failed: offer a retry
    case 'sign_in_again':
    case 'not_connected':
      return null
  }
}

const result = (status: GoogleStatus): GoogleStatusResult => ({ status, canChange: false, signedInAt: null })

export async function fetchGoogleStatus(idToken: string): Promise<GoogleStatusResult> {
  try {
    const res = await fetch('/api/google/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    })
    if (res.status === 401) return result('unauthorized')
    if (res.status !== 200) return result('failed')
    const body = (await res.json()) as { connected?: unknown; signInAgain?: unknown; canChange?: unknown; signedInAt?: unknown }
    return {
      status: body.connected === true ? 'connected' : body.signInAgain === true ? 'sign_in_again' : 'not_connected',
      canChange: body.canChange === true,
      signedInAt: typeof body.signedInAt === 'string' ? body.signedInAt : null,
    }
  } catch {
    return result('failed')
  }
}
