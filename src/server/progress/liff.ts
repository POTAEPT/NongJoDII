import { ensureGroupAccess, requireLiffUser } from '../liff-auth'
import type { LineMessage } from '../line/types'
import { log } from '../log'
import type { ApiResult, Deps } from '../ports'
import { resolveReminderAction } from '../reminders/answer'
import { type ReminderAction, parseReminderAction } from '../reminders/postback'
import { field } from '../review/load'
import { resolveProgressAction } from './handle-postback'
import { parseProgressAction } from './postback'

// POST /api/progress/answer. A progress card was pressed without a userId, so the bot
// replied with a LIFF button carrying the same postback data (IDs only). Here LINE login
// identifies the presser (rules: a press is never acted on from a missing userId), and
// the press runs through the same core as the webhook. The answer shows on the LIFF
// page: the reply token was already used for the LIFF button, and pushes are not used.

export type ProgressLiffBody = {
  result: string
  text: string
  /** Picker buttons, when the outcome asks the person to pick a Task. */
  choices: { label: string; data: string }[]
}

export async function answerProgressFromLiff(deps: Deps, body: unknown): Promise<ApiResult> {
  const user = await requireLiffUser(deps, field(body, 'idToken'))
  if (!user) return { status: 401, body: { error: 'unauthorized' } }
  const data = field(body, 'data')
  const action = typeof data === 'string' ? parseProgressAction(data) : null
  if (!action) {
    // The same LIFF login page also serves the reminder buttons (#45).
    const reminder = typeof data === 'string' ? parseReminderAction(data) : null
    if (reminder) return answerReminderFromLiff(deps, user.lineUserId, reminder)
    return { status: 400, body: { error: 'bad_request', field: 'data' } }
  }

  // The group comes from the stored card or message, never from the client.
  let groupId: string | null = null
  if (action.kind === 'answer' || action.kind === 'wrong_task') {
    groupId = (await deps.store.getProgressPrompt(action.promptId))?.groupId ?? null
  } else {
    groupId = (await deps.store.getMessageRef(action.messageId))?.groupId ?? null
  }
  const group = groupId ? await deps.store.getGroupById(groupId) : null
  if (!group) return { status: 404, body: { error: 'not_found' } }
  const member = await ensureGroupAccess(deps, { groupId: group.id, lineGroupId: group.lineGroupId, lineUserId: user.lineUserId })
  if (!member) return { status: 403, body: { error: 'forbidden' } }

  const outcome = await resolveProgressAction(deps, { groupId: group.id, userId: user.lineUserId, action })
  log('progress_liff_answer', { groupId: group.id, result: outcome.result })
  const out: ProgressLiffBody = { result: outcome.result, text: messageText(outcome.message), choices: postbackChoices(outcome.message) }
  return { status: 200, body: out }
}

/** #45: a reminder button pressed without a userId, repeated here after LINE login. The group
 *  comes from the stored Task, never from the client. */
async function answerReminderFromLiff(deps: Deps, lineUserId: string, action: ReminderAction): Promise<ApiResult> {
  const task = await deps.store.getTask(action.taskId)
  const group = task ? await deps.store.getGroupById(task.groupId) : null
  if (!group) return { status: 404, body: { error: 'not_found' } }
  const member = await ensureGroupAccess(deps, { groupId: group.id, lineGroupId: group.lineGroupId, lineUserId })
  if (!member) return { status: 403, body: { error: 'forbidden' } }
  const outcome = await resolveReminderAction(deps, { groupId: group.id, userId: lineUserId, action, pickedDate: null })
  log('reminder_liff_answer', { groupId: group.id, result: outcome.result })
  const out: ProgressLiffBody = { result: outcome.result, text: messageText(outcome.message), choices: postbackChoices(outcome.message) }
  return { status: 200, body: out }
}

function messageText(m: LineMessage): string {
  if (m.type === 'text') return m.text
  return m.altText
}

/** The postback buttons of a Flex message, in order. */
export function postbackChoices(m: LineMessage): { label: string; data: string }[] {
  if (m.type !== 'flex') return []
  const out: { label: string; data: string }[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    const a = n.action as { type?: unknown; label?: unknown; data?: unknown } | undefined
    if (n.type === 'button' && a?.type === 'postback' && typeof a.label === 'string' && typeof a.data === 'string') {
      out.push({ label: a.label, data: a.data })
    }
    for (const v of Object.values(n)) walk(v)
  }
  walk(m.contents)
  return out
}
