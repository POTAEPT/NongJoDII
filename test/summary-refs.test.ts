import { describe, expect, it } from 'vitest'
import { stripMessageRefs, substituteMemberRefs } from '@/server/summary/prompt'

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

describe('stripMessageRefs', () => {
  it('removes a leaked message ref with its Thai lead-in', () => {
    expect(stripMessageRefs('Nont แจ้งในข้อความ msg37 ที่ขอให้ส่งงาน')).toBe('Nont แจ้ง ที่ขอให้ส่งงาน')
    expect(stripMessageRefs('Nont แจ้งในข้อความ #37 ที่ขอให้ส่งงาน')).toBe('Nont แจ้ง ที่ขอให้ส่งงาน')
  })

  it('removes bracketed and bare refs', () => {
    expect(stripMessageRefs('ทำสไลด์ (msg2) ให้เสร็จ')).toBe('ทำสไลด์ ให้เสร็จ')
    expect(stripMessageRefs('ทำสไลด์ {msg2}.')).toBe('ทำสไลด์.')
    expect(stripMessageRefs('ตามที่คุยกันใน msg3, msg4 แล้ว')).toBe('ตามที่คุยกันใน, แล้ว')
  })

  it('keeps hash numbers and words that only look like refs', () => {
    expect(stripMessageRefs('รีวิว PR #36 ก่อนพรุ่งนี้')).toBe('รีวิว PR #36 ก่อนพรุ่งนี้')
    expect(stripMessageRefs('อัปโหลดไฟล์ขึ้น s3 กับ Galaxy S23')).toBe('อัปโหลดไฟล์ขึ้น s3 กับ Galaxy S23')
    expect(stripMessageRefs('ส่ง msgbox ใน items3')).toBe('ส่ง msgbox ใน items3')
  })

  it('keeps line breaks', () => {
    expect(stripMessageRefs('บรรทัดแรก msg1\nบรรทัดสอง')).toBe('บรรทัดแรก\nบรรทัดสอง')
  })
})
