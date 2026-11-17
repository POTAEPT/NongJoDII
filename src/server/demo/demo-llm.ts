import { randomUUID } from 'node:crypto'
import { OpenRouterClient } from '@/server/llm/openrouter'
import { OpenRouterDecisionsClient } from '@/server/llm/openrouter-decisions'
import type {
  DecisionAnswer, DecisionsPort, DecisionsRequest, DecisionsResult, LlmPort, LlmRequest, LlmResult, LlmUsage,
} from '@/server/ports'
import { CHAT_LINE_LABEL } from '@/server/progress/decide'
import { looksLikeProgress } from '@/server/progress/keywords'
import { priceTokens } from '@/server/usage/pricing'
import type { AiCall, AiCallKind } from './types'

/** The real model gets this long; after it the demo answers with a canned reply. */
export const DEMO_LLM_TIMEOUT_MS = 20_000
export const CANNED_MODEL = 'demo/canned'
/** Calls kept for the presenter (newest last). */
export const AI_CALLS_MAX = 50

/** The demo's AI: the real OpenRouter models (chat completions for the text model, the
 *  Decisions API for the progress decision model), and a canned answer in the shape the caller
 *  expects when there is no key, the call fails or it takes longer than DEMO_LLM_TIMEOUT_MS.
 *  The stage demo always gets an answer. Both kinds of call land in one list for the toasts. */
export class DemoLlm implements LlmPort, DecisionsPort {
  lastCallFallback = false
  model: string | null = null
  /** Finished calls since the last reset, newest last (at most AI_CALLS_MAX). */
  calls: AiCall[] = []
  /** Sum of every call's cost since the last reset (unpriced calls count 0). */
  totalUsd = 0
  /** The demo clock for the call times; buildDemo sets it. */
  clock: () => Date = () => new Date()
  private inFlight = 0
  private readonly inner: LlmPort | null
  private readonly decisionsInner: DecisionsPort | null
  private readonly timeoutMs: number

  /** Both undefined = OpenRouter with OPENROUTER_API_KEY (null when the key is missing). A
   *  caller that passes `inner` (tests) gets no real decisions adapter unless it passes one. */
  constructor(opts?: { inner?: LlmPort | null; decisions?: DecisionsPort | null; timeoutMs?: number }) {
    const apiKey = process.env.OPENROUTER_API_KEY
    const fromEnv = opts?.inner === undefined && opts?.decisions === undefined
    this.inner = opts?.inner !== undefined ? opts.inner : fromEnv && apiKey ? new OpenRouterClient({ apiKey }) : null
    this.decisionsInner = opts?.decisions !== undefined
      ? opts.decisions
      : fromEnv && apiKey ? new OpenRouterDecisionsClient({ apiKey }) : null
    this.timeoutMs = opts?.timeoutMs ?? DEMO_LLM_TIMEOUT_MS
  }

  get busy(): boolean {
    return this.inFlight > 0
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    this.inFlight += 1
    this.model = req.model
    try {
      if (!this.inner) throw new Error('no OPENROUTER_API_KEY')
      const timeoutMs = Math.min(this.timeoutMs, req.timeoutMs ?? this.timeoutMs)
      const result = await withTimeout(this.inner.complete({ ...req, timeoutMs }), timeoutMs)
      // An empty or unreadable answer would only become an error reply: answer canned instead.
      if (!usable(req, result.content)) throw new Error('model answer unusable')
      this.lastCallFallback = false
      this.model = result.model
      this.record(req, result, false)
      return result
    } catch {
      this.lastCallFallback = true
      this.model = CANNED_MODEL
      // Zero usage: a long offline demo must not walk into the Fair-use cap.
      const canned: LlmResult = { content: cannedAnswer(req), model: CANNED_MODEL, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
      this.record(req, canned, true)
      return canned
    } finally {
      this.inFlight -= 1
    }
  }

  /** The progress decision (TypeSafe Jev). On failure: a canned answer from the chat line's
   *  keywords, recorded as a fallback that costs 0. */
  async decide(req: DecisionsRequest): Promise<DecisionsResult> {
    this.inFlight += 1
    this.model = req.model
    try {
      if (!this.decisionsInner) throw new Error('no OPENROUTER_API_KEY')
      const timeoutMs = Math.min(this.timeoutMs, req.timeoutMs ?? this.timeoutMs)
      const result = await withTimeout(this.decisionsInner.decide({ ...req, timeoutMs }), timeoutMs)
      this.lastCallFallback = false
      this.model = result.model
      // Priced by the slug asked for: OpenRouter echoes a dated one (typesafe/jev-1.14-20261014).
      this.recordUsage('progress', result.model, result.usage, false, req.model)
      return result
    } catch {
      this.lastCallFallback = true
      this.model = CANNED_MODEL
      const canned: DecisionsResult = {
        model: CANNED_MODEL, answers: cannedDecisions(req), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }
      this.recordUsage('progress', CANNED_MODEL, canned.usage, true)
      return canned
    } finally {
      this.inFlight -= 1
    }
  }

  /** Forgets the calls and the total (a reset). */
  clearCalls(): void {
    this.calls = []
    this.totalUsd = 0
  }

  private record(req: LlmRequest, result: LlmResult, fallback: boolean): void {
    this.recordUsage(callKind(req), result.model, result.usage, fallback, req.model)
  }

  /** The cost OpenRouter reported; else the tokens at the app's price for the model asked
   *  (estimated); else null. */
  private recordUsage(kind: AiCallKind, model: string, u: LlmUsage | null, fallback: boolean, pricedModel = model): void {
    const reported = u?.costUsd ?? null
    const estimated = !fallback && reported === null && u !== null
    const costUsd = fallback ? 0 : reported ?? (u ? priceTokens(pricedModel, u.inputTokens, u.outputTokens) : null)
    const call: AiCall = {
      id: randomUUID(), at: this.clock().toISOString(), kind, model,
      inputTokens: u?.inputTokens ?? 0, outputTokens: u?.outputTokens ?? 0, costUsd, estimated, fallback,
    }
    this.calls.push(call)
    if (this.calls.length > AI_CALLS_MAX) this.calls.splice(0, this.calls.length - AI_CALLS_MAX)
    this.totalUsd += costUsd ?? 0
  }
}

/** What a chat call was for, from its schema (Summary) or its prompt. Progress decisions go
 *  through decide() and are always 'progress'. */
export function callKind(req: LlmRequest): AiCallKind {
  if (req.schema?.name === 'summary') return 'summary'
  if (/\btags?\b|แท็ก/i.test(req.system)) return 'tags'
  return 'other'
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('demo llm timeout')), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function usable(req: LlmRequest, content: string): boolean {
  if (req.schema?.name !== 'summary') return content.trim() !== ''
  try {
    const o = JSON.parse(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { summary?: unknown }
    return typeof o.summary === 'string' && o.summary.trim() !== ''
  } catch {
    return false
  }
}

/** A valid answer for the request's schema, built from the prompt alone. */
export function cannedAnswer(req: LlmRequest): string {
  if (req.schema?.name === 'summary') return JSON.stringify(cannedSummary(req.system, req.user))
  return '{}'
}

/** Canned decision answers from the request alone: the chat line's keywords say whether it is
 *  progress (0.9, else 0.1) and its status; a choice picks the keyword status when offered,
 *  else the first key (the first Task); a score picks the lowest level. */
export function cannedDecisions(req: DecisionsRequest): Record<string, DecisionAnswer | null> {
  // #157: the Summary pre-check (has_task, task_count) has no canned reading: no answer, so
  // the Summary runs as before and the canned Summary decides the Tasks.
  if ('has_task' in req.questions) return Object.fromEntries(Object.keys(req.questions).map((k) => [k, null]))
  const at = req.state.lastIndexOf(`${CHAT_LINE_LABEL}\n`)
  const line = at >= 0 ? req.state.slice(at + CHAT_LINE_LABEL.length + 1) : ''
  const keyword = looksLikeProgress(line)
  const out: Record<string, DecisionAnswer | null> = {}
  for (const [key, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      const noul = keyword ? 0.9 : 0.1
      out[key] = { type: 'noul', noul, confidence: Math.max(noul, 1 - noul) }
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria)
      const choice = keyword && keys.includes(keyword) ? keyword : keys[0]
      out[key] = choice === undefined ? null : { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 }
    } else {
      out[key] = { type: 'score', score: 0, probabilities: { 0: 0.9 }, confidence: 0.9 }
    }
  }
  return out
}

// ---- canned Summary ----

type PromptMember = { ref: string; names: string[] }
type PromptLine = { ref: string; time: string; sender: string; text: string }
type CannedTask = { title: string; details: string | null; assignee: string | null; due: string | null; source: string | null; tags: string[] }

const MEMBER_LINE = /^(m\d+): LINE name "([^"]*)"; nicknames: (.*); role: (.*)$/
const CHAT_LINE = /^(msg\d+) \[([^\]]+)\] (m\d+|\?): (.*)$/
/** Words that mark a line as asking someone to do something. */
const ASK = /(ฝาก|รบกวน|ช่วย|ขอให้|มอบหมาย|please|รับผิดชอบ)/i
const POLITE_TAIL = /(\s*(ด้วย|หน่อย|นะ|ครับ|คับ|ค่ะ|คะ|จ้า|จ้ะ|เลย|ให้|ได้ไหม|ได้มั้ย|ได้ป่ะ|มั้ย|ไหม|[!?.~ๆ🙏]))+$/u

export function cannedSummary(system: string, user: string): { summary: string; tasks: CannedTask[] } {
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(system)?.[1] ?? null
  const members: PromptMember[] = []
  const lines: PromptLine[] = []
  let inChat = false
  for (const raw of user.split('\n')) {
    const m = MEMBER_LINE.exec(raw)
    if (m) {
      const nick = m[3] === '-' ? [] : m[3].split(',').map((s) => s.trim()).filter(Boolean)
      members.push({ ref: m[1], names: [m[2], ...nick].filter((n) => n && n !== 'unknown') })
      continue
    }
    if (raw.startsWith('Chat (')) {
      inChat = true
      continue
    }
    const c = inChat ? CHAT_LINE.exec(raw) : null
    if (c) lines.push({ ref: c[1], time: c[2], sender: c[3], text: c[4] })
  }

  const tasks: CannedTask[] = []
  lines.forEach((line, i) => {
    if (tasks.length >= 10 || !ASK.test(line.text)) return
    const assignee = findAssignee(line, members)
    const title = taskTitle(line.text, members)
    if (!assignee || title.length < 4) return
    // The deadline is in the asking line, or else in the next few lines of the thread.
    const following = lines.slice(i + 1, i + 4).map((l) => l.text).join(' ')
    const due = today ? (findDue(line.text, today) ?? findDue(following, today)) : null
    tasks.push({ title, details: null, assignee, due, source: line.ref, tags: [] })
  })

  const senders = [...new Set(lines.map((l) => l.sender).filter((s) => s !== '?'))].map((r) => `{${r}}`)
  const gist = lines.slice(-3).map((l) => `"${clip(stripRefs(l.text), 60)}"`).join(' ')
  const people = senders.length > 0 ? senders.join(' ') : 'สมาชิก'
  const work = tasks.length > 0
    ? `มีงานที่ต้องทำ ${tasks.length} งาน: ${tasks.map((t) => `${t.title} (${t.assignee ? `{${t.assignee}}` : 'ยังไม่มีผู้รับ'})`).join(', ')}`
    : 'ไม่มีการมอบหมายงาน'
  const summary = `${people} คุยกัน ${lines.length} ข้อความ ล่าสุด: ${gist || '-'} ${work}`
  return { summary: clip(summary, 780), tasks }
}

function findAssignee(line: PromptLine, members: PromptMember[]): string | null {
  const tagged = /@\{(m\d+)\}/.exec(line.text)?.[1]
  if (tagged) return tagged
  const lower = line.text.toLocaleLowerCase('th')
  let best: { ref: string; at: number } | null = null
  for (const m of members) {
    if (m.ref === line.sender) continue
    for (const name of m.names) {
      const at = lower.indexOf(name.toLocaleLowerCase('th'))
      if (at >= 0 && (best === null || at < best.at)) best = { ref: m.ref, at }
    }
  }
  return best?.ref ?? null
}

function taskTitle(text: string, members: PromptMember[]): string {
  let t = stripRefs(text)
  const ask = ASK.exec(t)
  if (ask) t = t.slice(ask.index + ask[0].length)
  for (const m of members) for (const name of m.names) if (name) t = t.split(name).join(' ')
  t = t.replace(/^\s*(คุณ|น้อง|พี่)?\s*/u, '').replace(/\s+/g, ' ').trim()
  // A deadline clause ("ภายใน...", "ก่อน...") belongs to due, not the title.
  t = t.replace(/\s*(ภายใน|ก่อน|ส่ง)?(วัน)?(พรุ่งนี้|มะรืน|จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์).*$/u, '')
  t = t.replace(POLITE_TAIL, '').trim()
  return clip(t, 100)
}

const WEEKDAY: Array<[RegExp, number]> = [
  [/จันทร์/, 1], [/อังคาร/, 2], [/พุธ/, 3], [/พฤหัส/, 4], [/ศุกร์/, 5], [/เสาร์/, 6], [/อาทิตย์/, 7],
]
const THAI_NUM: Record<string, number> = {
  หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10, สิบเอ็ด: 11,
}

/** A deadline in Thai chat words, as ISO 8601 with +07:00; null when none is said. */
export function findDue(text: string, today: string): string | null {
  const base = new Date(`${today}T00:00:00Z`)
  let days: number | null = null
  if (/มะรืน/.test(text)) days = 2
  else if (/พรุ่งนี้/.test(text)) days = 1
  else if (/วันนี้|คืนนี้/.test(text)) days = 0
  else {
    const isoToday = ((base.getUTCDay() + 6) % 7) + 1
    for (const [re, wd] of WEEKDAY) {
      if (re.test(text)) {
        days = ((wd - isoToday + 7) % 7) || 7
        break
      }
    }
  }
  if (days === null) return null
  let hh = 17
  let mm = 0
  const clock = /(\d{1,2})[:.](\d{2})/.exec(text)
  const evening = /(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)\s*โมงเย็น/.exec(text)
  const morning = /(\d{1,2}|เจ็ด|แปด|เก้า|สิบเอ็ด|สิบ)\s*โมง(เช้า)?(?!เย็น)/.exec(text)
  const afternoon = /บ่าย\s*(\d{1,2}|สอง|สาม|สี่)?\s*โมง/.exec(text)
  const noon = /เที่ยง/.test(text)
  if (clock) {
    hh = Number(clock[1])
    mm = Number(clock[2])
  } else if (evening) {
    hh = 12 + (Number(evening[1]) || THAI_NUM[evening[1]] || 5)
  } else if (afternoon) {
    hh = 12 + (afternoon[1] ? Number(afternoon[1]) || THAI_NUM[afternoon[1]] || 1 : 1)
  } else if (morning) {
    hh = Number(morning[1]) || THAI_NUM[morning[1]] || 9
  } else if (noon) {
    hh = 12
  }
  if (hh > 23 || mm > 59) {
    hh = 17
    mm = 0
  }
  const d = new Date(base.getTime() + days * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(hh)}:${pad(mm)}:00+07:00`
}

function stripRefs(text: string): string {
  return text.replace(/@\{m\d+\}/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(t: string, max: number): string {
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
