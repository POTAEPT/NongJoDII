'use client'

import type { Liff } from '@line/liff'

/** Props shared by every LIFF view (google, review, task). Views get only the ID
 *  token, never a LINE user ID: the server derives the user from the verified token. */
export type LiffViewProps = { liff: Liff; idToken: string; liffId: string; id: string | null }

export async function initLiff(liffId: string): Promise<{ liff: Liff; idToken: string } | { redirecting: true }> {
  const { default: liff } = await import('@line/liff')
  await liff.init({ liffId })
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href })
    return { redirecting: true }
  }
  const idToken = liff.getIDToken()
  if (!idToken) throw new Error('no LIFF ID token')
  return { liff, idToken }
}
