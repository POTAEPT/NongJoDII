/** Result of POST /api/google/status as seen by the LIFF page. */
export type GoogleStatus = 'connected' | 'not_connected' | 'unauthorized' | 'failed'

export type ReturnPhase = 'connected' | 'unauthorized' | 'failed'

/** Where GoogleView goes when the user comes back to LINE while sign-in is open
 *  in the external browser. null = stay in 'opened' (sign-in not finished yet). */
export function phaseOnReturn(status: GoogleStatus): ReturnPhase | null {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'unauthorized':
      return 'unauthorized' // LINE rejected the saved token: reopen from the chat
    case 'failed':
      return 'failed' // the status request failed: offer a retry
    case 'not_connected':
      return null
  }
}

export async function fetchGoogleStatus(idToken: string): Promise<GoogleStatus> {
  try {
    const res = await fetch('/api/google/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    })
    if (res.status === 401) return 'unauthorized'
    if (res.status !== 200) return 'failed'
    const { connected } = (await res.json()) as { connected?: unknown }
    return connected === true ? 'connected' : 'not_connected'
  } catch {
    return 'failed'
  }
}
