import { createHmac } from 'node:crypto'
import type { LineEvent } from '@/server/line/types'

/** x-line-signature as LINE computes it: HMAC-SHA256 of the raw body with the channel
 *  secret, in base64. */
export function lineSignature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

/** A webhook POST as LINE sends it, signed with the demo channel secret. */
export function signedWebhookRequest(events: LineEvent[], secret: string): Request {
  const body = JSON.stringify({ destination: 'Udemobot', events })
  return new Request('http://demo.local/api/line/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': lineSignature(body, secret) },
    body,
  })
}
