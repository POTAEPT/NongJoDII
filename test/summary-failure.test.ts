import { describe, expect, it } from 'vitest'
import { SUMMARY_FAILED_TEXT, summaryFailedText, summaryFailure } from '@/server/summary/failure'
import { ModelOutputError } from '@/server/summary/parse-output'
import { AdapterError } from '@/server/log'

describe('summaryFailure: why a Summary failed', () => {
  it('outside the AI step is always the system', () => {
    expect(summaryFailure(new AdapterError('supabase listRecentTextMessages: PGRST201'), false)).toBe('system')
    expect(summaryFailure(new AdapterError('openrouter timeout'), false)).toBe('system')
  })

  it.each([
    [new AdapterError('openrouter timeout'), 'ai_timeout'],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'ai_timeout'],
    [Object.assign(new Error('x'), { name: 'AbortError' }), 'ai_timeout'],
    [new AdapterError('openrouter 429'), 'ai_busy'],
    [new AdapterError('openrouter 500'), 'ai_busy'],
    [new AdapterError('openrouter 503'), 'ai_busy'],
    [new AdapterError('openrouter 402'), 'ai_credits'],
    [new AdapterError('openrouter 401'), 'ai_error'],
    [new ModelOutputError(), 'ai_output'],
    [new SyntaxError('Unexpected token'), 'ai_error'],
    ['a string', 'ai_error'],
  ] as const)('%s in the AI step is %s', (err, reason) => {
    expect(summaryFailure(err, true)).toBe(reason)
  })
})

describe('summaryFailedText', () => {
  it('names the reason and ends with the code and the Bangkok time', () => {
    const at = new Date('2026-11-16T07:01:51Z') // 14:01 Bangkok
    expect(summaryFailedText('system', at)).toBe(`สรุปแชตไม่สำเร็จ: ${SUMMARY_FAILED_TEXT.system}\nรหัส: SUM-SYS 14:01`)
    expect(summaryFailedText('ai_busy', at)).toMatch(/\nรหัส: SUM-AI-BUSY 14:01$/)
  })

  it('every reason has its own text, within one LINE text message', () => {
    const texts = Object.values(SUMMARY_FAILED_TEXT)
    expect(new Set(texts).size).toBe(texts.length)
    for (const r of Object.keys(SUMMARY_FAILED_TEXT) as (keyof typeof SUMMARY_FAILED_TEXT)[]) {
      expect(summaryFailedText(r, new Date()).length).toBeLessThan(5000)
    }
  })
})
