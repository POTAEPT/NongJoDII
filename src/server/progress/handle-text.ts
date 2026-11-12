import { log } from '../log'
import type { Deps, Member, ProgressTarget, TaskRow } from '../ports'
import { pickerCard, progressCard } from './card'
import { canMove, decide, type Decision } from './decide'
import { looksLikeProgress } from './keywords'

// #7 Track progress, entry 1: a normal text line in a group. Runs after the message is
// stored (webhook/process.ts), so a model failure can never lose it. Every answer is a
// reply (free), never a push. Ordinary chat gets no reply.

export type ProgressTextJob = {
  groupId: string
  storedMessageId: string          // messages.id
  senderLineUserId: string
  text: string
  sentAt: Date
  replyToken: string
}

export type ProgressTextResult = 'skipped' | 'ignored' | 'asked' | 'picker' | 'already_open'

/** Bot commands ("NongJoDII summarize", "NongJoDII done", ...) belong to other features. */
const COMMAND = /^\s*@?nongjodii\b/i
const MAX_PICKER_TASKS = 4

export function displayName(members: Member[], lineUserId: string | null): string {
  return members.find((m) => m.lineUserId === lineUserId)?.displayName ?? 'สมาชิก'
}

/** Picker choices: the sender's own Tasks first, then unowned ones, then the rest. */
export function pickerCandidates(tasks: TaskRow[], status: ProgressTarget, senderLineUserId: string | null): TaskRow[] {
  const rank = (t: TaskRow) => (t.assigneeLineUserId === senderLineUserId ? 0 : t.assigneeLineUserId === null ? 1 : 2)
  return tasks
    .filter((t) => canMove(t.status, status))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_PICKER_TASKS)
}

export async function handleProgressText(deps: Deps, job: ProgressTextJob): Promise<ProgressTextResult> {
  const { store, line } = deps
  const { groupId, replyToken } = job
  if (!job.text.trim() || COMMAND.test(job.text)) return 'skipped'

  const group = await store.getGroupById(groupId)
  if (!group || !group.featureTrackRemind) return 'skipped'
  const tasks = await store.listOpenTasks(groupId)
  if (tasks.length === 0) return 'skipped'
  const members = await store.listLiveMembers(groupId)

  // AI calls are billed to the confirmed Owner (#6). Without one, use the free keyword check.
  const owner = group.ownerConfirmedAt ? group.nominatedOwnerLineUserId : null
  const decision: Decision = owner
    ? await decide(
        deps,
        { ownerLineUserId: owner, projectId: group.projectId, groupId },
        { text: job.text, senderLineUserId: job.senderLineUserId, members, tasks, workDescription: group.workDescription },
      )
    : { kind: 'failed' }

  switch (decision.kind) {
    case 'none':
      return 'ignored'

    case 'match': {
      const task = tasks.find((t) => t.id === decision.taskId)
      if (!task) return 'ignored'
      if (await store.findOpenProgressPrompt(task.id)) return 'already_open'
      const { prompt } = await store.createProgressPrompt({
        groupId, taskId: task.id, targetStatus: decision.status,
        subjectLineUserId: job.senderLineUserId, triggerMessageId: job.storedMessageId, askedAt: deps.now(),
      })
      if (!prompt) return 'already_open'
      await line.reply(replyToken, [
        progressCard({ prompt, task, senderName: displayName(members, job.senderLineUserId), sentAt: job.sentAt }),
      ])
      log('progress_asked', { groupId, taskId: task.id, promptId: prompt.id, target: decision.status })
      return 'asked'
    }

    case 'ambiguous': {
      const picked = decision.taskIds
        .map((id) => tasks.find((t) => t.id === id))
        .filter((t): t is TaskRow => t !== undefined)
      await line.reply(replyToken, [pickerCard({ messageId: job.storedMessageId, tasks: picked, targetStatus: decision.status })])
      log('progress_picker', { groupId, choices: picked.length, reason: 'ambiguous' })
      return 'picker'
    }

    case 'failed': {
      // No model answered: ask the group only when the line looks like progress.
      const status = looksLikeProgress(job.text)
      if (!status) return 'ignored'
      const candidates = pickerCandidates(tasks, status, job.senderLineUserId)
      if (candidates.length === 0) return 'ignored'
      await line.reply(replyToken, [pickerCard({ messageId: job.storedMessageId, tasks: candidates, targetStatus: status })])
      log('progress_picker', { groupId, choices: candidates.length, reason: 'no_model' })
      return 'picker'
    }
  }
}
