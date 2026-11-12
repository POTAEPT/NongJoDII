import { describe, expect, it } from 'vitest'
import { substituteMemberRefs } from '@/server/summary/prompt'

describe('substituteMemberRefs', () => {
  const names = new Map<string, string | null>([
    ['m1', 'Pim Sirin'],
    ['m2', null],
  ])

  it('replaces refs with LINE names and a null name with สมาชิก', () => {
    expect(substituteMemberRefs('{m1} ทำสไลด์ให้ {m2}', names)).toBe('Pim Sirin ทำสไลด์ให้ สมาชิก')
  })

  it('turns an unknown ref into สมาชิก', () => {
    expect(substituteMemberRefs('{m9}', names)).toBe('สมาชิก')
  })

  it('leaves text without braced refs unchanged', () => {
    expect(substituteMemberRefs('ไม่มีชื่อ', names)).toBe('ไม่มีชื่อ')
    expect(substituteMemberRefs('m1 ทำ', names)).toBe('m1 ทำ')
  })
})
