import { describe, expect, it } from 'vitest'
import { open, openState, seal, sealState } from '@/server/crypto/secretbox'
import { TEST_KEY, TEST_NOW } from './harness'

const MIN = 60_000

function flipChar(s: string): string {
  const c = s[0] === 'A' ? 'B' : 'A'
  return c + s.slice(1)
}

describe('seal / open', () => {
  it('round-trips the plaintext', () => {
    expect(open(seal('rt-secret', TEST_KEY), TEST_KEY)).toBe('rt-secret')
  })

  it('gives a different output for each seal of the same text (random IV)', () => {
    expect(seal('same', TEST_KEY)).not.toBe(seal('same', TEST_KEY))
  })

  it('output is v1 plus three base64url parts and does not contain the plaintext', () => {
    const sealed = seal('refresh-token-plaintext', TEST_KEY)
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/)
    expect(sealed).not.toContain('refresh-token-plaintext')
  })

  it('returns null for a tampered ciphertext char', () => {
    const [v, iv, tag, ct] = seal('rt-secret', TEST_KEY).split('.')
    expect(open([v, iv, tag, flipChar(ct)].join('.'), TEST_KEY)).toBeNull()
  })

  it('returns null for the wrong key', () => {
    expect(open(seal('rt-secret', TEST_KEY), Buffer.alloc(32, 9))).toBeNull()
  })

  it('returns null for a v2. prefix', () => {
    const sealed = seal('rt-secret', TEST_KEY)
    expect(open('v2' + sealed.slice(2), TEST_KEY)).toBeNull()
  })

  it('returns null for a tag cut to 4 bytes', () => {
    const [v, iv, tag, ct] = seal('rt-secret', TEST_KEY).split('.')
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url')
    expect(open([v, iv, short, ct].join('.'), TEST_KEY)).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(open('', TEST_KEY)).toBeNull()
    expect(open('v1.only', TEST_KEY)).toBeNull()
  })
})

describe('sealState / openState', () => {
  it('round-trips the LINE user ID', () => {
    const state = sealState('Uowner1', TEST_NOW, TEST_KEY)
    expect(openState(state, TEST_NOW, TEST_KEY)).toEqual({ lineUserId: 'Uowner1' })
  })

  it('hides the LINE user ID', () => {
    expect(sealState('Uowner1', TEST_NOW, TEST_KEY)).not.toContain('Uowner1')
  })

  it('is valid at +9 min and expired at exactly +10 min', () => {
    const state = sealState('Uowner1', TEST_NOW, TEST_KEY)
    expect(openState(state, new Date(TEST_NOW.getTime() + 9 * MIN), TEST_KEY)).toEqual({ lineUserId: 'Uowner1' })
    expect(openState(state, new Date(TEST_NOW.getTime() + 10 * MIN), TEST_KEY)).toBeNull()
  })

  it('returns null for a sealed payload whose p is not google_oauth', () => {
    const other = seal(JSON.stringify({ p: 'other', u: 'Uowner1', exp: TEST_NOW.getTime() + 10 * MIN }), TEST_KEY)
    expect(openState(other, TEST_NOW, TEST_KEY)).toBeNull()
  })

  it('returns null for a state sealed with another key or not JSON', () => {
    expect(openState(sealState('Uowner1', TEST_NOW, Buffer.alloc(32, 9)), TEST_NOW, TEST_KEY)).toBeNull()
    expect(openState(seal('not json', TEST_KEY), TEST_NOW, TEST_KEY)).toBeNull()
    expect(openState(seal('null', TEST_KEY), TEST_NOW, TEST_KEY)).toBeNull()
  })
})
