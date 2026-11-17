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

  it('leaves text without refs unchanged', () => {
    expect(substituteMemberRefs('ไม่มีชื่อ', names)).toBe('ไม่มีชื่อ')
  })

  // Live 2026-11-17: the model wrote refs without braces ("m1", "ม1") into the summary.
  describe('bare refs', () => {
    const three = new Map<string, string | null>([['m1', 'Naruekot'], ['m2', 'Test'], ['m3', 'Ploy']])

    it.each([
      ['m1 ทำสไลด์', 'Naruekot ทำสไลด์'],
      ['ม1 ให้ทำสไลด์ ส่วนม2 ทำรายงาน', 'Naruekot ให้ทำสไลด์ ส่วนTest ทำรายงาน'],
      ['ม.2 ทำรายงาน', 'Test ทำรายงาน'],
      ['ตามคำสั่งของ m1.', 'ตามคำสั่งของ Naruekot.'],
      ['ผู้รับ (m2)', 'ผู้รับ (Test)'],
      ['ผู้รับ [m2]', 'ผู้รับ Test'],
      ['m1-m3 ช่วยกันทำ', 'Naruekot, Test, Ploy ช่วยกันทำ'],
      ['ม1–ม2 ช่วยกันทำ', 'Naruekot, Test ช่วยกันทำ'],
      ['{ม3} จองห้อง', 'Ploy จองห้อง'],
    ])('%j becomes %j', (raw, want) => {
      expect(substituteMemberRefs(raw, three)).toBe(want)
    })

    it('keeps words and numbers that are not refs in this prompt', () => {
      expect(substituteMemberRefs('m9 ทำ', three)).toBe('m9 ทำ')
      expect(substituteMemberRefs('ม.6 กับ m10', three)).toBe('ม.6 กับ m10')
      expect(substituteMemberRefs('msg1 ห้อง 5m1 Apple M1 rm1', three)).toBe('msg1 ห้อง 5m1 Apple M1 rm1')
      expect(substituteMemberRefs('[m9]', three)).toBe('[m9]')
    })

    it('a range with an unknown end swaps only the known end', () => {
      expect(substituteMemberRefs('m2-m9', three)).toBe('Test-m9')
    })

    it('a LINE name put in for a ref is not read again', () => {
      expect(substituteMemberRefs('{m1} และ m2', new Map([['m1', 'm2'], ['m2', 'Test']]))).toBe('m2 และ Test')
    })
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
