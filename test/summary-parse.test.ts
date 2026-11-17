import { describe, expect, it } from 'vitest'
import { ModelOutputError, parseSummaryOutput, settleMidnightDue, settleWeekdayDue } from '@/server/summary/parse-output'

const task = (over: Record<string, unknown> = {}) => ({
  title: 'ทำสไลด์', details: null, assignee: 'm1', due: null, source: 'msg1', ...over,
})
const json = (tasks: unknown[], summary: unknown = 'สรุป') => JSON.stringify({ summary, tasks })

describe('parseSummaryOutput', () => {
  it('parses valid JSON', () => {
    const out = parseSummaryOutput(json([task({ details: 'รายละเอียด' })]))
    expect(out).toEqual({
      summary: 'สรุป',
      tasks: [{ title: 'ทำสไลด์', details: 'รายละเอียด', assigneeRef: 'm1', due: null, sourceRef: 'msg1', tags: [] }],
    })
  })

  it('parses a fenced block', () => {
    const out = parseSummaryOutput('```json\n' + json([task()]) + '\n```')
    expect(out.summary).toBe('สรุป')
    expect(out.tasks).toHaveLength(1)
  })

  it('throws ModelOutputError on invalid JSON', () => {
    expect(() => parseSummaryOutput('not json')).toThrow(ModelOutputError)
  })

  it('throws when the summary is missing', () => {
    expect(() => parseSummaryOutput(JSON.stringify({ tasks: [] }))).toThrow(ModelOutputError)
    expect(() => parseSummaryOutput(json([], '   '))).toThrow(ModelOutputError)
  })

  it('keeps 10 of 15 tasks', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => task({ title: `t${i}` }))
    const out = parseSummaryOutput(json(tasks))
    expect(out.tasks.map((t) => t.title)).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`))
  })

  it('nulls an assignee that is not a member ref', () => {
    expect(parseSummaryOutput(json([task({ assignee: 'Pim' })])).tasks[0].assigneeRef).toBeNull()
  })

  it('parses a due date with the +07:00 offset', () => {
    const out = parseSummaryOutput(json([task({ due: '2026-11-20T17:00:00+07:00' })]))
    expect(out.tasks[0].due).toEqual(new Date('2026-11-20T10:00:00Z'))
  })

  it('a date-only due (a day, no time) is 23:59 Bangkok that day', () => {
    const out = parseSummaryOutput(json([task({ due: '2026-11-20' })]))
    expect(out.tasks[0].due).toEqual(new Date('2026-11-20T23:59:00+07:00'))
  })

  it('nulls an unparseable due date', () => {
    expect(parseSummaryOutput(json([task({ due: 'next friday' })])).tasks[0].due).toBeNull()
  })

  it('drops a task with an empty title', () => {
    const out = parseSummaryOutput(json([task({ title: '  ' }), task({ title: 7 }), task()]))
    expect(out.tasks).toHaveLength(1)
  })

  it('nulls a bad source ref and treats missing tasks as none', () => {
    expect(parseSummaryOutput(json([task({ source: '14' })])).tasks[0].sourceRef).toBeNull()
    expect(parseSummaryOutput(JSON.stringify({ summary: 'x' })).tasks).toEqual([])
  })

  it('reads a source ref written as msg14, {msg14} or the older #14', () => {
    for (const source of ['msg14', '{msg14}', '#14']) {
      expect(parseSummaryOutput(json([task({ source })])).tasks[0].sourceRef).toBe('msg14')
    }
  })
})

describe('settleMidnightDue', () => {
  const midnight = new Date('2026-11-19T00:00:00+07:00')

  it('keeps a stated time', () => {
    const five = new Date('2026-11-20T17:00:00+07:00')
    expect(settleMidnightDue(five, 'ส่งศุกร์ห้าโมงเย็น')).toEqual(five)
  })

  it('a T00:00 answer with no midnight word in the message is 23:59 that day', () => {
    expect(settleMidnightDue(midnight, 'ทำรายงานให้ ส่งวันพฤหัสนะ')).toEqual(new Date('2026-11-19T23:59:00+07:00'))
  })

  it.each(['ส่งพฤหัสก่อนเที่ยงคืน', 'ส่งภายใน 24:00 วันพฤหัส', 'ส่งพฤหัส 00.00', 'due Thursday at midnight', 'ส่งพฤหัส 6 ทุ่ม'])(
    'a T00:00 answer stays 00:00 when the message says midnight: %j',
    (text) => {
      expect(settleMidnightDue(midnight, text)).toEqual(midnight)
    },
  )

  it('a 10:00 or 20:00 time is not read as midnight', () => {
    expect(settleMidnightDue(midnight, 'ประชุม 10:00 ส่ง 20.00')).toEqual(new Date('2026-11-19T23:59:00+07:00'))
  })

  it('no due stays null', () => {
    expect(settleMidnightDue(null, 'เที่ยงคืน')).toBeNull()
  })
})

describe('settleWeekdayDue', () => {
  // Tuesday 17 Nov 2026, 13:30 in Bangkok.
  const now = new Date('2026-11-17T06:30:00Z')
  const bkk = (s: string) => new Date(`${s}+07:00`)

  it.each(['2026-11-18T23:59:00', '2026-11-24T23:59:00'])('"ส่งวันพฤหัส" moves a due of %s to Thu 19 Nov', (wrong) => {
    expect(settleWeekdayDue(bkk(wrong), 'ผมทำรายงานให้ ส่งวันพฤหัส', now)).toEqual(bkk('2026-11-19T23:59:00'))
  })

  it('"พฤหัสหน้า" is Thu 26 Nov, even when the model gave this week\'s Thursday', () => {
    expect(settleWeekdayDue(bkk('2026-11-19T23:59:00'), 'ส่งพฤหัสหน้านะ', now)).toEqual(bkk('2026-11-26T23:59:00'))
    expect(settleWeekdayDue(bkk('2026-11-25T23:59:00'), 'ส่งพฤหัสหน้านะ', now)).toEqual(bkk('2026-11-26T23:59:00'))
  })

  it('"ศุกร์นี้ห้าโมงเย็น" keeps 17:00 and lands on Fri 20 Nov', () => {
    expect(settleWeekdayDue(bkk('2026-11-19T17:00:00'), 'สไลด์ขอศุกร์นี้ห้าโมงเย็น', now)).toEqual(bkk('2026-11-20T17:00:00'))
  })

  it('a right weekday is kept, and so is a later week of it', () => {
    expect(settleWeekdayDue(bkk('2026-11-19T23:59:00'), 'ส่งวันพฤหัส', now)).toEqual(bkk('2026-11-19T23:59:00'))
    expect(settleWeekdayDue(bkk('2026-11-26T23:59:00'), 'ส่งวันพฤหัส', now)).toEqual(bkk('2026-11-26T23:59:00'))
  })

  it('a due before today on the right weekday moves forward', () => {
    expect(settleWeekdayDue(bkk('2026-11-12T18:00:00'), 'พฤหัส 6 โมงเย็น', now)).toEqual(bkk('2026-11-19T18:00:00'))
  })

  it('"ภายใน 20 พ.ย." stays untouched', () => {
    expect(settleWeekdayDue(bkk('2026-11-20T23:59:00'), 'ส่งภายใน 20 พ.ย.', now)).toEqual(bkk('2026-11-20T23:59:00'))
    expect(settleWeekdayDue(bkk('2026-11-21T23:59:00'), 'ศุกร์ 21 พ.ย. นะ', now)).toEqual(bkk('2026-11-21T23:59:00'))
  })

  it('a message with no weekday stays untouched', () => {
    expect(settleWeekdayDue(bkk('2026-11-18T12:00:00'), 'ทำสไลด์ให้ ส่งพรุ่งนี้เที่ยง', now)).toEqual(bkk('2026-11-18T12:00:00'))
    expect(settleWeekdayDue(bkk('2026-11-18T12:00:00'), 'ไปศึกษาเพิ่ม แล้วสั่งอาหาร', now)).toEqual(bkk('2026-11-18T12:00:00'))
  })

  it('no due or no source message: nothing to check', () => {
    expect(settleWeekdayDue(null, 'ส่งวันพฤหัส', now)).toBeNull()
    expect(settleWeekdayDue(bkk('2026-11-18T23:59:00'), null, now)).toEqual(bkk('2026-11-18T23:59:00'))
  })
})
