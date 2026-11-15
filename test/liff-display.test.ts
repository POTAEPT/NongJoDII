import { describe, expect, it } from 'vitest'
import { AVATAR_TONES, avatarInitial, avatarTone, bangkokToday, dueLabel } from '@/app/liff/display'

describe('avatarInitial', () => {
  it('skips Thai leading vowels', () => {
    expect(avatarInitial('เจฟ')).toBe('จ')
    expect(avatarInitial('ไม้')).toBe('ม')
    expect(avatarInitial('นน')).toBe('น')
  })
  it('upper-cases latin names and handles empty names', () => {
    expect(avatarInitial('bew')).toBe('B')
    expect(avatarInitial('  ')).toBe('?')
  })
})

describe('avatarTone', () => {
  it('is stable per key and from the palette', () => {
    expect(avatarTone('U123')).toBe(avatarTone('U123'))
    expect(AVATAR_TONES).toContain(avatarTone('U999'))
  })
})

describe('dueLabel', () => {
  const today = '2026-11-13'
  it('says today and tomorrow by name', () => {
    expect(dueLabel('2026-11-13', '17:00', today)).toBe('วันนี้ 17:00')
    expect(dueLabel('2026-11-14', '13:00', today)).toBe('พรุ่งนี้ 13:00')
  })
  it('uses the Thai weekday and month for other days', () => {
    expect(dueLabel('2026-11-19', '', today)).toBe('พฤ. 19 พ.ย.')
    expect(dueLabel('2026-12-01', '09:30', today)).toBe('อ. 1 ธ.ค. 09:30')
  })
  it('is null without a valid date', () => {
    expect(dueLabel('', '10:00', today)).toBeNull()
    expect(dueLabel('nope', '', today)).toBeNull()
  })
})

describe('bangkokToday', () => {
  it('rolls over at midnight Bangkok time', () => {
    expect(bangkokToday(new Date('2026-11-13T16:59:00Z'))).toBe('2026-11-13')
    expect(bangkokToday(new Date('2026-11-13T17:00:00Z'))).toBe('2026-11-14')
  })
})
