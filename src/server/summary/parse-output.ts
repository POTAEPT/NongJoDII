import { suggestedTags } from '../tasks/tags'

export type ParsedTask = {
  title: string; details: string | null; assigneeRef: string | null; due: Date | null; sourceRef: string | null
  tags: string[]   // #109: cleaned by tasks/tags.ts; [] when the model gave none
}

/** Constant message: never include the model's content (it quotes chat). */
export class ModelOutputError extends Error {
  name = 'ModelOutputError'
  constructor() {
    super('model output invalid')
  }
}

/** #111: the shape parseSummaryOutput reads, sent as the request's JSON Schema (strict:
 *  every property required, nullable ones typed [..., 'null'], no extra properties). The
 *  parser still checks every field: the schema lowers bad output, it does not replace the
 *  check. test/ai-schemas.test.ts keeps the two in step. */
export const SUMMARY_SCHEMA = {
  name: 'summary',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'tasks'],
    properties: {
      summary: { type: 'string' },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'details', 'assignee', 'due', 'source', 'tags'],
          properties: {
            title: { type: 'string' },
            details: { type: ['string', 'null'] },
            assignee: { type: ['string', 'null'] },
            due: { type: ['string', 'null'] },
            source: { type: ['string', 'null'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
}

const SUMMARY_MAX = 1500
const TITLE_MAX = 200
const DETAILS_MAX = 2000
const TASKS_MAX = 10
const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i

export function parseSummaryOutput(content: string): { summary: string; tasks: ParsedTask[] } {
  const trimmed = content.trim()
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new ModelOutputError()
  }
  if (typeof raw !== 'object' || raw === null) throw new ModelOutputError()
  const obj = raw as { summary?: unknown; tasks?: unknown }
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') throw new ModelOutputError()
  const summary = obj.summary.trim().slice(0, SUMMARY_MAX)

  const tasks: ParsedTask[] = []
  for (const item of Array.isArray(obj.tasks) ? obj.tasks : []) {
    const task = parseTask(item)
    if (task) tasks.push(task)
    if (tasks.length === TASKS_MAX) break
  }
  return { summary, tasks }
}

function parseTask(item: unknown): ParsedTask | null {
  if (typeof item !== 'object' || item === null) return null
  const t = item as Record<string, unknown>
  if (typeof t.title !== 'string') return null
  const title = t.title.trim().slice(0, TITLE_MAX)
  if (title === '') return null
  const details = typeof t.details === 'string' ? t.details.trim().slice(0, DETAILS_MAX) || null : null
  const assigneeRef = typeof t.assignee === 'string' && /^m\d+$/.test(t.assignee) ? t.assignee : null
  const sourceRef = typeof t.source === 'string' ? readSourceRef(t.source) : null
  let due: Date | null = null
  if (typeof t.due === 'string') {
    const d = new Date(t.due)
    if (!Number.isNaN(d.getTime())) due = d
  }
  return { title, details, assigneeRef, due, sourceRef, tags: suggestedTags(t.tags) }
}

/** "msg14" is the prompt's form; "{msg14}" and the older "#14" are accepted and
 *  normalized to "msg14". Anything else is no source. */
function readSourceRef(source: string): string | null {
  const m = /^(?:\{msg(\d+)\}|msg(\d+)|#(\d+))$/.exec(source.trim())
  return m ? `msg${m[1] ?? m[2] ?? m[3]}` : null
}
