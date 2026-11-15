import { describe, expect, it } from 'vitest'
import { parseGroupCommand } from '@/server/commands/parse'

describe('parseGroupCommand', () => {
  it.each(['NongJoDII summarize', 'nongjodii SUMMARIZE', '  NongJoDII   สรุปหน่อย ', '@NongJoDII summarize', 'NongJoDIIสรุปหน่อย'])(
    'matches %j',
    (text) => {
      expect(parseGroupCommand(text)).toBe('summarize')
    },
  )

  it.each(['น้องจดดี สรุปหน่อย', '@น้องจดดี สรุปหน่อย', 'น้องจดดีสรุปหน่อย', 'น้องจดดี summarize'])(
    'matches the Thai name %j (Figma UI v4 #3)',
    (text) => {
      expect(parseGroupCommand(text)).toBe('summarize')
    },
  )

  it('reads the typed reminder fallbacks under the Thai name too', () => {
    expect(parseGroupCommand('น้องจดดี done')).toBe('done')
    expect(parseGroupCommand('น้องจดดี need time')).toBe('need_time')
  })

  it.each(['NongJoDII ตั้งค่า', 'nongjodii SETTINGS', '@NongJoDII settings', 'น้องจดดี ตั้งค่า'])('matches %j as settings (#28)', (text) => {
    expect(parseGroupCommand(text)).toBe('settings')
  })

  it.each(['NongJoDII ขอไฟล์', '@NongJoDII ขอไฟล์', 'nongjodii   ขอไฟล์ ', 'น้องจดดี ขอไฟล์', 'NongJoDIIขอไฟล์'])('matches %j as request_file (#33)', (text) => {
    expect(parseGroupCommand(text)).toBe('request_file')
  })

  it.each([
    ['น้องจดดี ตั้งค่าหน่อย', 'settings'],
    ['น้องจดดี ตั้งค่าหน่อยครับ', 'settings'],
    ['น้องจดดี, ตั้งค่า', 'settings'],
    ['น้องจดดี: ตั้งค่าให้หน่อยนะคะ!', 'settings'],
    ['น้องจดดี สรุปหน่อยครับ', 'summarize'],
    ['น้องจดดี สรุปหน่อยนะ', 'summarize'],
    ['น้องจดดี สรุป', 'summarize'],
    ['น้องจดดีสรุปให้หน่อยค่ะ', 'summarize'],
    ['NongJoDII summarize please', 'summarize'],
    ['NongJoDII summarize!', 'summarize'],
    ['NongJoDII ขอไฟล์หน่อย', 'request_file'],
    ['น้องจดดี ขอไฟล์ด้วยครับ', 'request_file'],
    ['น้องจดดี done ครับ', 'done'],
  ])('accepts polite words and punctuation after the command: %j (#85)', (text, command) => {
    expect(parseGroupCommand(text)).toBe(command)
  })

  it.each([
    'summarize', 'สรุปหน่อย', 'ขอไฟล์', 'จดดี สรุปหน่อย', 'ตั้งค่า', null,
    // Ordinary chat that contains a command word is not a command.
    'ตั้งค่าห้องแล้ว', 'น้องจดดี ตั้งค่าห้องแล้ว', 'น้องจดดี สรุปงานเมื่อวานให้ที', 'เดี๋ยวสรุปหน่อยนะ น้องจดดี',
    'NongJoDII summarize the meeting', 'น้องจดดี ขอไฟล์สไลด์',
  ])('does not match %j', (text) => {
    expect(parseGroupCommand(text)).toBeNull()
  })
})
