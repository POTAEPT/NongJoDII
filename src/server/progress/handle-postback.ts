import type { LineMessage } from '../line/types'
import { log } from '../log'
import type { Deps, ProgressPromptRow, TaskRow } from '../ports'
import { PROGRESS_REPLY, pickerCard, resultCard, textMessage } from './card'
import { canMove } from './decide'
import { displayName, pickerCandidates } from './handle-text'
import { parseProgressAction } from './postback'

// #7 Track progress, entry 2: a button press on a progress card. Only a person's Yes
// moves a Task (rules: Tasks and AI), and only the Task's assignee or the person who
// wrote the progress line may answer (decided 2026-11-12). A press without a userId
// changes nothing: LINE guarantees userId only on message events.

export type ProgressPostbackJob = {
  groupId: string
  userId: string | null
  data: string
  replyToken: string
}

export type ProgressPostbackResult =
  | 'not_mine' | 'refused' | 'already_answered' | 'gone' | 'kept' | 'updated' | 'picker' | 'dismissed'

function allowedAnswerers(task: TaskRow, subject: string | null): string[] {
  return [...new Set([task.assigneeLineUserId, subject].filter((x): x is string => x !== null))]
}

export async function handleProgressPostback(deps: Deps, job: ProgressPostbackJob): Promise<ProgressPostbackResult> {
  const action = parseProgressAction(job.data)
  if (!action) return 'not_mine'

  const { store, line } = deps
  const { groupId, userId, replyToken } = job
  const now = deps.now()
  const say = (m: LineMessage) => line.reply(replyToken, [m])

  if (!userId) {
    await say(textMessage(PROGRESS_REPLY.noUserId))
    return 'refused'
  }
  if (action.kind === 'not_update') {
    await say(textMessage(PROGRESS_REPLY.notUpdate))
    return 'dismissed'
  }

  const members = await store.listLiveMembers(groupId)

  const mayAnswer = async (task: TaskRow, subject: string | null): Promise<boolean> => {
    const allowed = allowedAnswerers(task, subject)
    if (allowed.includes(userId)) return true
    await say(textMessage(PROGRESS_REPLY.notAllowed(allowed.map((id) => displayName(members, id)))))
    log('progress_refused', { groupId, taskId: task.id })
    return false
  }

  /** Claims the card first (the first answer wins), then moves the Task. */
  const applyYes = async (prompt: ProgressPromptRow, task: TaskRow): Promise<ProgressPostbackResult> => {
    if (!(await store.answerProgressPrompt(prompt.id, 'yes', userId, now)).updated) {
      await say(textMessage(PROGRESS_REPLY.alreadyAnswered))
      return 'already_answered'
    }
    // In Process means the sender takes the Task ("ต้น รับงานนี้ใช่ไหม?").
    const assignTo = prompt.targetStatus === 'in_process' ? (prompt.subjectLineUserId ?? userId) : null
    const { updated } = await store.moveTaskStatus({
      taskId: task.id, fromStatus: task.status, toStatus: prompt.targetStatus, byLineUserId: userId, assignTo, at: now,
    })
    if (!updated) {
      await say(textMessage(PROGRESS_REPLY.taskGone))
      return 'gone'
    }
    await say(resultCard({
      task, status: prompt.targetStatus, confirmedByName: displayName(members, userId),
      assigneeName: assignTo ? displayName(members, assignTo) : null, at: now,
    }))
    log('progress_updated', { groupId, taskId: task.id, promptId: prompt.id, target: prompt.targetStatus })
    return 'updated'
  }

  if (action.kind === 'pick') {
    const msg = await store.getMessageRef(action.messageId)
    const task = await store.getTask(action.taskId)
    if (!msg || msg.groupId !== groupId || !task || task.groupId !== groupId || task.deletedAt) {
      await say(textMessage(PROGRESS_REPLY.taskGone))
      return 'gone'
    }
    if (!(await mayAnswer(task, msg.senderLineUserId))) return 'refused'
    if (task.status === action.targetStatus) {
      await say(textMessage(PROGRESS_REPLY.alreadyAnswered))
      return 'already_answered'
    }
    if (!canMove(task.status, action.targetStatus)) {
      await say(textMessage(PROGRESS_REPLY.taskGone))
      return 'gone'
    }
    // The pick is the person's answer: store the card and its Yes together.
    const { prompt } = await store.createProgressPrompt({
      groupId, taskId: task.id, targetStatus: action.targetStatus,
      subjectLineUserId: msg.senderLineUserId, triggerMessageId: msg.id, askedAt: now,
    })
    if (!prompt) {
      await say(textMessage(PROGRESS_REPLY.openCardExists))
      return 'already_answered'
    }
    return applyYes(prompt, task)
  }

  // answer / wrong_task act on an existing card.
  const prompt = await store.getProgressPrompt(action.promptId)
  const task = prompt ? await store.getTask(prompt.taskId) : null
  if (!prompt || prompt.groupId !== groupId || !task) {
    await say(textMessage(PROGRESS_REPLY.taskGone))
    return 'gone'
  }
  if (!(await mayAnswer(task, prompt.subjectLineUserId))) return 'refused'
  if (prompt.answer !== null) {
    await say(textMessage(PROGRESS_REPLY.alreadyAnswered))
    return 'already_answered'
  }

  if (action.kind === 'answer' && action.answer === 'yes') {
    if (task.deletedAt || !canMove(task.status, prompt.targetStatus)) {
      await say(textMessage(PROGRESS_REPLY.taskGone))
      return 'gone'
    }
    return applyYes(prompt, task)
  }

  // No, or "ผิดงาน": close the card; the Task is not touched.
  if (!(await store.answerProgressPrompt(prompt.id, 'no', userId, now)).updated) {
    await say(textMessage(PROGRESS_REPLY.alreadyAnswered))
    return 'already_answered'
  }
  if (action.kind === 'answer') {
    await say(textMessage(PROGRESS_REPLY.keptAsIs))
    return 'kept'
  }

  const others = pickerCandidates(
    (await store.listOpenTasks(groupId)).filter((t) => t.id !== task.id),
    prompt.targetStatus,
    prompt.subjectLineUserId,
  )
  if (others.length === 0 || !prompt.triggerMessageId) {
    await say(textMessage(PROGRESS_REPLY.noOtherTask))
    return 'kept'
  }
  await say(pickerCard({ messageId: prompt.triggerMessageId, tasks: others, targetStatus: prompt.targetStatus }))
  return 'picker'
}
