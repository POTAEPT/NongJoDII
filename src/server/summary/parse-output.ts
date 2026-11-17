import { suggestedTags } from '../tasks/tags'
import { bangkokEndOfDay, bangkokParts } from '../time/bangkok'

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
            due: {
              type: ['string', 'null'],
              description: 'YYYY-MM-DD when the chat names a day but no time; YYYY-MM-DDTHH:MM:SS+07:00 when it names a time; null when no deadline.',
            },
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
  return { title, details, assigneeRef, due: parseDue(t.due), sourceRef, tags: suggestedTags(t.tags) }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** A deadline with a day but no time ("YYYY-MM-DD") is 23:59 Bangkok that day, never the
 *  start of it (a Task due at 00:00 looks overdue all day). A date-time is kept as given. */
export function parseDue(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  const d = new Date(DATE_ONLY.test(s) ? `${s}T23:59:00+07:00` : s)
  return Number.isNaN(d.getTime()) ? null : d
}

// Words for midnight: เที่ยงคืน, หกทุ่ม (6 ทุ่ม), ตีศูนย์, midnight, and 00:00 / 0.00 / 24:00.
const MIDNIGHT = /เที่ยงคืน|หก\s*ทุ่ม|(?<!\d)6\s*ทุ่ม|ตี\s*(?:ศูนย์|0)|midnight|(?<!\d)(?:0?0|24)[:.]00(?!\d)/i

/** The model often writes T00:00 for a deadline that names only a day. A due at 00:00
 *  Bangkok becomes 23:59 that day unless `chatText` (the raw text of the message the Task
 *  came from, never a prompt line, which starts with its time) speaks of midnight. */
export function settleMidnightDue(due: Date | null, chatText: string): Date | null {
  if (due === null) return null
  const p = bangkokParts(due)
  if (p.hh !== 0 || p.mm !== 0 || MIDNIGHT.test(chatText)) return due
  return bangkokEndOfDay(due)
}

/** "msg14" is the prompt's form; "{msg14}" and the older "#14" are accepted and
 *  normalized to "msg14". Anything else is no source. */
function readSourceRef(source: string): string | null {
  const m = /^(?:\{msg(\d+)\}|msg(\d+)|#(\d+))$/.exec(source.trim())
  return m ? `msg${m[1] ?? m[2] ?? m[3]}` : null
}
