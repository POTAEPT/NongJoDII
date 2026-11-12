import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyLineSignature } from '@/server/line/signature'

const sign = (body: string, secret = 'secret') => createHmac('sha256', secret).update(body).digest('base64')

describe('verifyLineSignature', () => {
  const body = '{"events":[]}'
  it('accepts a correctly signed body', () => {
    expect(verifyLineSignature(body, sign(body), 'secret')).toBe(true)
  })
  it('rejects a one-byte change to the body', () => {
    expect(verifyLineSignature('{"events":[ ]}', sign(body), 'secret')).toBe(false)
  })
  it('rejects a wrong secret', () => {
    expect(verifyLineSignature(body, sign(body, 'other'), 'secret')).toBe(false)
  })
  it('rejects a null or empty header', () => {
    expect(verifyLineSignature(body, null, 'secret')).toBe(false)
    expect(verifyLineSignature(body, '', 'secret')).toBe(false)
  })
  it('rejects garbage without throwing', () => {
    expect(verifyLineSignature(body, '@@@', 'secret')).toBe(false)
  })
  it('handles a Thai body as UTF-8', () => {
    const thai = '{"text":"สรุปหน่อย"}'
    expect(verifyLineSignature(thai, sign(thai), 'secret')).toBe(true)
  })
})
