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

  it.each(['NongJoDII summarize please', 'summarize', 'สรุปหน่อย', 'NongJoDII ขอไฟล์', 'น้องจดดี สรุปหน่อยนะ', 'จดดี สรุปหน่อย', 'ตั้งค่า', null])('does not match %j', (text) => {
    expect(parseGroupCommand(text)).toBeNull()
  })
})
