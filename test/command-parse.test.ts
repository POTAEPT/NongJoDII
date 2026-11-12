import { describe, expect, it } from 'vitest'
import { parseGroupCommand } from '@/server/commands/parse'

describe('parseGroupCommand', () => {
  it.each(['NongJoDII summarize', 'nongjodii SUMMARIZE', '  NongJoDII   สรุปหน่อย ', '@NongJoDII summarize', 'NongJoDIIสรุปหน่อย'])(
    'matches %j',
    (text) => {
      expect(parseGroupCommand(text)).toBe('summarize')
    },
  )

  it.each(['NongJoDII summarize please', 'summarize', 'สรุปหน่อย', 'NongJoDII ขอไฟล์', null])('does not match %j', (text) => {
    expect(parseGroupCommand(text)).toBeNull()
  })
})
