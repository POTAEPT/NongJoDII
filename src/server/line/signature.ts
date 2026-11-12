import { createHmac, timingSafeEqual } from 'node:crypto'

/** HMAC-SHA256 of the exact raw body, keyed with the channel secret, base64,
 *  compared in constant time with the x-line-signature header (.greptile/rules.md). */
export function verifyLineSignature(rawBody: string, signature: string | null, channelSecret: string): boolean {
  if (!signature) return false
  const expected = createHmac('sha256', channelSecret).update(rawBody, 'utf8').digest()
  let given: Buffer
  try { given = Buffer.from(signature, 'base64') } catch { return false }
  return given.length === expected.length && timingSafeEqual(given, expected)
}
