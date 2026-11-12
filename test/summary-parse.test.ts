import { describe, expect, it } from 'vitest'
import { ModelOutputError, parseSummaryOutput } from '@/server/summary/parse-output'

const task = (over: Record<string, unknown> = {}) => ({
  title: 'ทำสไลด์', details: null, assignee: 'm1', due: null, source: 's1', ...over,
})
const json = (tasks: unknown[], summary: unknown = 'สรุป') => JSON.stringify({ summary, tasks })

describe('parseSummaryOutput', () => {
  it('parses valid JSON', () => {
    const out = parseSummaryOutput(json([task({ details: 'รายละเอียด' })]))
    expect(out).toEqual({
      summary: 'สรุป',
      tasks: [{ title: 'ทำสไลด์', details: 'รายละเอียด', assigneeRef: 'm1', due: null, sourceRef: 's1' }],
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

  it('reads a source ref written as s14, {s14} or the older #14', () => {
    for (const source of ['s14', '{s14}', '#14']) {
      expect(parseSummaryOutput(json([task({ source })])).tasks[0].sourceRef).toBe('s14')
    }
  })
})
