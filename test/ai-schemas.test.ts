import { describe, expect, it } from 'vitest'
import { parseSummaryOutput, SUMMARY_SCHEMA } from '@/server/summary/parse-output'
import { buildSummaryPrompt } from '@/server/summary/prompt'

// #111: each chat-model call sends a JSON Schema (OpenRouter structured outputs, strict). These
// tests keep each schema in step with the parser that reads the answer: an answer the schema
// allows must parse, the schema must follow the strict-mode rules, and the prompt must name
// the same fields. A tiny validator covers the JSON Schema subset the schemas use. The progress
// decision model answers typed questions instead (Decisions API, test/openrouter-decisions.test.ts).

type Schema = Record<string, unknown>

function valid(schema: Schema, v: unknown): boolean {
  const types = ([] as unknown[]).concat(schema.type ?? [])
  const typeOk = types.length === 0 || types.some((t) =>
    t === 'null' ? v === null
      : t === 'array' ? Array.isArray(v)
        : t === 'integer' ? Number.isInteger(v)
          : t === 'object' ? typeof v === 'object' && v !== null && !Array.isArray(v)
            : typeof v === t)
  if (!typeOk) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) return false
  if (Array.isArray(v) && schema.items) return v.every((x) => valid(schema.items as Schema, x))
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && schema.properties) {
    const props = schema.properties as Record<string, Schema>
    const o = v as Record<string, unknown>
    if ((schema.required as string[] ?? []).some((k) => !(k in o))) return false
    if (schema.additionalProperties === false && Object.keys(o).some((k) => !(k in props))) return false
    return Object.entries(o).every(([k, x]) => !props[k] || valid(props[k], x))
  }
  return true
}

/** Strict mode: every object lists all its properties as required and allows no others. */
function strictProblems(schema: Schema, path = '$'): string[] {
  const out: string[] = []
  if (schema.properties) {
    const keys = Object.keys(schema.properties as object).sort()
    if (JSON.stringify([...(schema.required as string[] ?? [])].sort()) !== JSON.stringify(keys)) out.push(`${path}: required != properties`)
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`)
    for (const [k, s] of Object.entries(schema.properties as Record<string, Schema>)) out.push(...strictProblems(s, `${path}.${k}`))
  }
  if (schema.items) out.push(...strictProblems(schema.items as Schema, `${path}[]`))
  return out
}

describe('SUMMARY_SCHEMA and parseSummaryOutput', () => {
  it('follows the strict-mode rules', () => {
    expect(strictProblems(SUMMARY_SCHEMA.schema)).toEqual([])
  })

  it('an answer the schema allows parses, with every field read', () => {
    const answer = {
      summary: 'สรุป',
      tasks: [
        { title: 'ทำสไลด์', details: 'd', assignee: 'm1', due: '2026-11-20T17:00:00+07:00', source: 'msg2', tags: ['ออกแบบ', '#สไลด์'] },
        { title: 'จองห้อง', details: null, assignee: null, due: null, source: null, tags: [] },
      ],
    }
    expect(valid(SUMMARY_SCHEMA.schema, answer)).toBe(true)
    const parsed = parseSummaryOutput(JSON.stringify(answer))
    expect(parsed.tasks[0]).toMatchObject({ title: 'ทำสไลด์', details: 'd', assigneeRef: 'm1', sourceRef: 'msg2', tags: ['ออกแบบ', 'สไลด์'] })
    expect(parsed.tasks[0].due?.toISOString()).toBe('2026-11-20T10:00:00.000Z')
    expect(parsed.tasks[1]).toMatchObject({ details: null, assigneeRef: null, due: null, sourceRef: null })
  })

  it('rejects what the parser would drop (sanity check of the validator)', () => {
    expect(valid(SUMMARY_SCHEMA.schema, { summary: 'x' })).toBe(false)
    expect(valid(SUMMARY_SCHEMA.schema, { summary: 'x', tasks: [{ title: 1 }] })).toBe(false)
    expect(valid(SUMMARY_SCHEMA.schema, { summary: 'x', tasks: [], extra: 1 })).toBe(false)
  })

  it('the prompt names exactly the schema\'s fields', () => {
    const { system } = buildSummaryPrompt({ now: new Date(), workDescription: null, members: [], messages: [] })
    const shape = system.split('\n').find((l) => l.startsWith('{"summary"'))!
    const props = SUMMARY_SCHEMA.schema.properties
    for (const k of Object.keys(props)) expect(shape).toContain(`"${k}"`)
    for (const k of Object.keys(props.tasks.items.properties)) expect(shape).toContain(`"${k}"`)
  })
})
