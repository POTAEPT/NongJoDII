import { logError } from '../log'
import type { Deps, Member, ProgressTarget, TaskRow, TaskStatus } from '../ports'
import { FairUseCapReachedError, runMeteredAi, type MeterContext } from '../usage/meter'
import { DECISION_MODEL, TEXT_MODEL } from '../usage/pricing'

// Asks the AI whether a chat line reports progress on one of the group's open Tasks.
// The answer is a proposal only: a person must still press Yes (rules: Tasks and AI).
// Decision model first; on a failure or an unusable answer, the text model (#7).

export type Decision =
  | { kind: 'none' }
  | { kind: 'match'; taskId: string; status: ProgressTarget }
  | { kind: 'ambiguous'; taskIds: string[]; status: ProgressTarget }
  | { kind: 'failed' }   // no model gave a usable answer, or the Fair-use cap was reached

export type DecideInput = {
  text: string; senderLineUserId: string; members: Member[]; tasks: TaskRow[]; workDescription: string | null
}

const MAX_TOKENS = 1000
const MAX_CHOICES = 4

export const DECIDE_SYSTEM = `You read one LINE group chat message (often Thai) and decide whether it reports progress on one of the group's open tasks.
Return ONLY a JSON object, no prose, in one of these forms:
{"kind":"none"}  - not about task progress (chat, questions, plans, jokes, asking about someone else's task)
{"kind":"match","task":<number>,"status":"done"|"in_process"}  - clearly about exactly one task
{"kind":"ambiguous","tasks":[<number>,...],"status":"done"|"in_process"}  - progress, but it could be 2-4 of the tasks
status "done" = the sender says the work is finished, sent or uploaded.
status "in_process" = the sender says they started it or will take it themselves, for a task nobody owns yet.
"Not finished yet" or a question is NOT progress. Use the task numbers from the list. People may be called by nicknames.`

/** Forward only: Done from any open status; In Process only from Not Assigned. */
export function canMove(from: TaskStatus, to: ProgressTarget): boolean {
  if (to === 'done') return from !== 'done'
  return from === 'not_assigned'
}

export function buildDecideUser(input: DecideInput): string {
  // Nicknames reach the AI only; cards show LINE names (decided 2026-11-11).
  const name = (id: string | null) => {
    const m = id === null ? undefined : input.members.find((x) => x.lineUserId === id)
    if (!m) return id === null ? 'nobody' : 'unknown'
    const shown = m.displayName ?? 'unknown'
    return m.nicknames.length > 0 ? `${shown} (nicknames: ${m.nicknames.join(', ')})` : shown
  }
  // Numbers, not UUIDs: the model can only pick a Task that exists, and it costs fewer tokens.
  const tasks = input.tasks
    .map((t, i) => `${i + 1}. ${t.title} [status: ${t.status}; owner: ${name(t.assigneeLineUserId)}]`)
    .join('\n')
  return [
    input.workDescription ? `The group works on: ${input.workDescription}` : null,
    `Open tasks:\n${tasks}`,
    `Sender: ${name(input.senderLineUserId)}`,
    `Message: ${input.text}`,
  ]
    .filter((x): x is string => x !== null)
    .join('\n\n')
}

/** Reads the model's JSON strictly. null = unusable (try the next model). */
export function parseDecision(raw: string, tasks: TaskRow[]): Exclude<Decision, { kind: 'failed' }> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.kind === 'none') return { kind: 'none' }

  const status = o.status
  if (status !== 'done' && status !== 'in_process') return null
  const byNumber = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) ? tasks[n - 1] : undefined)

  if (o.kind === 'match') {
    const task = byNumber(o.task)
    if (!task) return null
    return canMove(task.status, status) ? { kind: 'match', taskId: task.id, status } : { kind: 'none' }
  }
  if (o.kind === 'ambiguous') {
    if (!Array.isArray(o.tasks)) return null
    const picked = [...new Set(o.tasks.map(byNumber).filter((t): t is TaskRow => !!t && canMove(t.status, status)))]
    if (picked.length === 0) return { kind: 'none' }
    if (picked.length === 1) return { kind: 'match', taskId: picked[0].id, status }
    return { kind: 'ambiguous', taskIds: picked.slice(0, MAX_CHOICES).map((t) => t.id), status }
  }
  return null
}

/** Every call goes through runMeteredAi, so its tokens count against the Owner (#6). */
export async function decide(deps: Deps, ctx: Omit<MeterContext, 'purpose'>, input: DecideInput): Promise<Decision> {
  const user = buildDecideUser(input)
  for (const model of [DECISION_MODEL, TEXT_MODEL]) {
    let content: string
    try {
      const res = await runMeteredAi(
        deps, { ...ctx, purpose: 'progress_decision' }, { model, system: DECIDE_SYSTEM, user, maxTokens: MAX_TOKENS },
      )
      content = res.content
    } catch (err) {
      if (err instanceof FairUseCapReachedError) return { kind: 'failed' }
      logError('progress_model_failed', { groupId: ctx.groupId, model }, err)
      continue
    }
    const parsed = parseDecision(content, input.tasks)
    if (parsed) return parsed
  }
  return { kind: 'failed' }
}
