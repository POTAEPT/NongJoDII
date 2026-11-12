import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log } from '../log'
import type { Deps, ProgressPromptRow, TaskRow } from '../ports'
import { PROGRESS_REPLY, pickerCard, resultCard, textMessage } from './card'
import { canMove } from './decide'
import { displayName, pickerCandidates } from './handle-text'
import { parseProgressAction, type ProgressAction } from './postback'

// #7 Track progress, entry 2: a button press on a progress card. Only a person's Yes
// moves a Task (rules: Tasks and AI), and only the Task's assignee or the person who
// wrote the progress line may answer (decided 2026-11-12). A press without a userId is
// never acted on: the bot answers with a LIFF button, and LINE login identifies the
// presser there (rules: Tasks and AI; progress/liff.ts).

export type ProgressPostbackJob = {
  groupId: string
  userId: string | null
  data: string
  replyToken: string
}

export type ProgressPostbackResult =
  | 'not_mine' | 'needs_login' | 'refused' | 'already_answered' | 'gone' | 'kept' | 'updated' | 'picker' | 'dismissed'

/** What a press resolved to, and the one message that tells the presser. */
export type ProgressOutcome = { result: Exclude<ProgressPostbackResult, 'not_mine' | 'needs_login'>; message: LineMessage }

export async function handleProgressPostback(deps: Deps, job: ProgressPostbackJob): Promise<ProgressPostbackResult> {
  const action = parseProgressAction(job.data)
  if (!action) return 'not_mine'
  const reply = (m: LineMessage) => deps.line.reply(job.replyToken, [m])

  if (!job.userId && action.kind !== 'not_update') {
    await reply(loginMessage(deps.config.liffId, job.data))
    log('progress_needs_login', { groupId: job.groupId })
    return 'needs_login'
  }
  const outcome = await resolveProgressAction(deps, { groupId: job.groupId, userId: job.userId ?? '', action })
  await reply(outcome.message)
  return outcome.result
}

/** A button to the LIFF page that repeats this press after LINE login. Only the postback
 *  data (IDs only) travels in the link. */
function loginMessage(liffId: string, data: string): LineMessage {
  return {
    type: 'template',
    altText: PROGRESS_REPLY.needsLogin,
    template: {
      type: 'buttons',
      text: PROGRESS_REPLY.needsLogin,
      actions: [{ type: 'uri', label: 'ยืนยันตัวตน', uri: liffUrl(liffId, 'progress', data) }],
    },
  }
}

function allowedAnswerers(task: TaskRow, subject: string | null): string[] {
  return [...new Set([task.assigneeLineUserId, subject].filter((x): x is string => x !== null))]
}

/** The core of a press, shared by the webhook (userId from LINE) and the LIFF page
 *  (userId from a verified LINE login). `userId` is always a known person here. */
export async function resolveProgressAction(
  deps: Deps,
  p: { groupId: string; userId: string; action: ProgressAction },
): Promise<ProgressOutcome> {
  const { store } = deps
  const { groupId, userId, action } = p
  const now = deps.now()
  const say = (result: ProgressOutcome['result'], text: string): ProgressOutcome => ({ result, message: textMessage(text) })

  if (action.kind === 'not_update') return say('dismissed', PROGRESS_REPLY.notUpdate)

  const members = await store.listLiveMembers(groupId)

  /** null = may answer; otherwise the refusal. */
  const refusal = (task: TaskRow, subject: string | null): ProgressOutcome | null => {
    const allowed = allowedAnswerers(task, subject)
    if (allowed.includes(userId)) return null
    log('progress_refused', { groupId, taskId: task.id })
    return say('refused', PROGRESS_REPLY.notAllowed(allowed.map((id) => displayName(members, id))))
  }

  /** The answer and the Task move in one transaction (rpc answer_progress_yes). */
  const applyYes = async (prompt: ProgressPromptRow, task: TaskRow): Promise<ProgressOutcome> => {
    // In Process means the sender takes the Task ("ต้น รับงานนี้ใช่ไหม?").
    const assignTo = prompt.targetStatus === 'in_process' ? (prompt.subjectLineUserId ?? userId) : null
    const { outcome } = await store.confirmProgressYes({
      promptId: prompt.id, taskId: task.id, fromStatus: task.status, toStatus: prompt.targetStatus,
      byLineUserId: userId, assignTo, at: now,
    })
    if (outcome === 'already_answered') return say('already_answered', PROGRESS_REPLY.alreadyAnswered)
    if (outcome === 'task_changed') return say('gone', PROGRESS_REPLY.taskGone)
    log('progress_updated', { groupId, taskId: task.id, promptId: prompt.id, target: prompt.targetStatus })
    return {
      result: 'updated',
      message: resultCard({
        task, status: prompt.targetStatus, confirmedByName: displayName(members, userId),
        assigneeName: assignTo ? displayName(members, assignTo) : null, at: now,
      }),
    }
  }

  if (action.kind === 'pick') {
    const msg = await store.getMessageRef(action.messageId)
    const task = await store.getTask(action.taskId)
    if (!msg || msg.groupId !== groupId || !task || task.groupId !== groupId || task.deletedAt) {
      return say('gone', PROGRESS_REPLY.taskGone)
    }
    const refused = refusal(task, msg.senderLineUserId)
    if (refused) return refused
    if (task.status === action.targetStatus) return say('already_answered', PROGRESS_REPLY.alreadyAnswered)
    if (!canMove(task.status, action.targetStatus)) return say('gone', PROGRESS_REPLY.taskGone)
    // The pick is the person's answer: a card row records it, answered at once.
    const { prompt } = await store.createProgressPrompt({
      groupId, taskId: task.id, targetStatus: action.targetStatus,
      subjectLineUserId: msg.senderLineUserId, triggerMessageId: msg.id, askedAt: now,
    })
    if (!prompt) return say('already_answered', PROGRESS_REPLY.openCardExists)
    const outcome = await applyYes(prompt, task)
    // Not applied: remove the row, so it cannot block the next card for this Task.
    if (outcome.result !== 'updated') await store.withdrawProgressPrompt(prompt.id)
    return outcome
  }

  // answer / wrong_task act on an existing card.
  const prompt = await store.getProgressPrompt(action.promptId)
  if (!prompt || prompt.groupId !== groupId) return say('gone', PROGRESS_REPLY.cardExpired)
  const task = await store.getTask(prompt.taskId)
  if (!task) return say('gone', PROGRESS_REPLY.taskGone)
  const refused = refusal(task, prompt.subjectLineUserId)
  if (refused) return refused
  if (prompt.answer !== null) return say('already_answered', PROGRESS_REPLY.alreadyAnswered)

  if (action.kind === 'answer' && action.answer === 'yes') {
    if (task.deletedAt || !canMove(task.status, prompt.targetStatus)) return say('gone', PROGRESS_REPLY.taskGone)
    return applyYes(prompt, task)
  }

  // No, or "ผิดงาน": close the card; the Task is not touched.
  if (!(await store.answerProgressPrompt(prompt.id, 'no', userId, now)).updated) {
    return say('already_answered', PROGRESS_REPLY.alreadyAnswered)
  }
  if (action.kind === 'answer') return say('kept', PROGRESS_REPLY.keptAsIs)

  const others = pickerCandidates(
    (await store.listOpenTasks(groupId)).filter((t) => t.id !== task.id),
    prompt.targetStatus,
    prompt.subjectLineUserId,
  )
  if (others.length === 0 || !prompt.triggerMessageId) return say('kept', PROGRESS_REPLY.noOtherTask)
  return {
    result: 'picker',
    message: pickerCard({ messageId: prompt.triggerMessageId, tasks: others, targetStatus: prompt.targetStatus }),
  }
}
