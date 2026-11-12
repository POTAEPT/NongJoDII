import { afterEach, describe, expect, test, vi } from 'vitest'
import { AdapterError, log, logError } from '@/server/log'

afterEach(() => {
  vi.restoreAllMocks()
})

function lastErrorLine(spy: { mock: { calls: unknown[][] } }): string {
  const calls = spy.mock.calls
  return String(calls[calls.length - 1][0])
}

describe('log', () => {
  test('writes one JSON line with the event and fields', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    log('webhook.received', { events: 2, redelivery: false })
    expect(JSON.parse(String(info.mock.calls[0][0]))).toEqual({
      event: 'webhook.received',
      events: 2,
      redelivery: false,
    })
  })
})

describe('logError', () => {
  test('an AdapterError keeps its message (status or code only)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', {}, new AdapterError('supabase m: 23503'))
    expect(JSON.parse(lastErrorLine(error))).toEqual({ event: 'x', error: 'supabase m: 23503' })
  })

  test('a plain Error logs only its name, never its message', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', { groupId: 'g1' }, new Error('ข้อความแชท'))
    const line = lastErrorLine(error)
    expect(JSON.parse(line)).toEqual({ event: 'x', groupId: 'g1', error: 'Error' })
    expect(line).not.toContain('ข้อความแชท')
  })

  test('a thrown string logs unknown', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    logError('x', {}, 'ข้อความแชท')
    const line = lastErrorLine(error)
    expect(JSON.parse(line)).toEqual({ event: 'x', error: 'unknown' })
    expect(line).not.toContain('ข้อความแชท')
  })

  test('AdapterError has the AdapterError name', () => {
    expect(new AdapterError('line reply 500').name).toBe('AdapterError')
  })
})
