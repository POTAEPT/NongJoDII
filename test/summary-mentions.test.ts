import { describe, expect, it } from 'vitest'
import type { MessageMention } from '@/server/ports'
import { withMentionRefs } from '@/server/summary/prompt'

// A tag becomes the live Member's ref; anything that cannot be trusted stays as written.
describe('withMentionRefs', () => {
  const refs = new Map([['Upim', 'm1'], ['Ubank', 'm2']])
  const user = (index: number, length: number, userId: string | null): MessageMention => ({ index, length, type: 'user', userId })

  it('swaps each tag of a live Member for its ref', () => {
    expect(withMentionRefs('@Pim กับ @Bank ทำสไลด์', [user(0, 4, 'Upim'), user(9, 5, 'Ubank')], refs))
      .toBe('@{m1} กับ @{m2} ทำสไลด์')
  })

  it('applies tags in text order whatever order LINE lists them', () => {
    expect(withMentionRefs('@Pim @Bank', [user(5, 5, 'Ubank'), user(0, 4, 'Upim')], refs)).toBe('@{m1} @{m2}')
  })

  it('counts offsets in UTF-16 code units, as LINE does', () => {
    expect(withMentionRefs('🍎 @Pim', [user(3, 4, 'Upim')], refs)).toBe('🍎 @{m1}')
  })

  it('leaves a tag without userId, of a non-Member, or of everyone as written', () => {
    const text = '@Pim @Lee @All'
    expect(withMentionRefs(text, [
      user(0, 4, null), user(5, 4, 'Uleft'), { index: 10, length: 4, type: 'all', userId: null },
    ], refs)).toBe(text)
  })

  it('ignores spans out of bounds, overlapping, empty, or not starting at @', () => {
    const text = '@Pim hi'
    expect(withMentionRefs(text, [user(5, 9, 'Upim')], refs)).toBe(text)
    expect(withMentionRefs(text, [user(-1, 3, 'Upim')], refs)).toBe(text)
    expect(withMentionRefs(text, [user(1, 3, 'Upim')], refs)).toBe(text)
    expect(withMentionRefs(text, [user(0, 0, 'Upim')], refs)).toBe(text)
    expect(withMentionRefs(text, [user(0, 4, 'Upim'), user(0, 2, 'Ubank')], refs)).toBe('@{m1} hi')
  })

  it('returns the text unchanged without mentions', () => {
    expect(withMentionRefs('hi', null, refs)).toBe('hi')
  })
})
