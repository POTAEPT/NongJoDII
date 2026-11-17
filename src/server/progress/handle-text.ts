import { log, logError } from '../log'
import type { Deps, Member, ProgressTarget, TaskRow } from '../ports'
import { pickerCard, progressCard } from './card'
import { canMove, decide, type Decision } from './decide'
import { looksLikeProgress } from './keywords'

// #7 Track progress, entry 1: a normal text line in a group. Runs after the message is
// stored (webhook/process.ts), so a model failure can never lose it. Every answer is a
// reply (free), never a push. Ordinary chat gets no reply.
// #132: the free keyword list is a gate. A line without a progress word makes no model
// call; only a match goes to the decision model (TypeSafe Jev), which then decides the Task
// and status. When it does not answer, the free picker asks the group (F3.4).

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
/** An unanswered card older than this no longer blocks a new one for the same Task. */
export const PROMPT_STALE_MS = 24 * 3600_000

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
  // The keyword gate (#132): ordinary chat costs nothing, no store read and no model call.
  const keywordStatus = looksLikeProgress(job.text)
  if (!keywordStatus) return 'ignored'

  const group = await store.getGroupById(groupId)
  if (!group || !group.featureTrackRemind) return 'skipped'
  const tasks = await store.listOpenTasks(groupId)
  if (tasks.length === 0) return 'skipped'
  const members = await store.listLiveMembers(groupId)

  // AI calls are billed to the confirmed Owner (#6). Without one, the free picker answers.
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
      const open = await store.findOpenProgressPrompt(task.id)
      if (open) {
        // An open card blocks new ones for this Task. One nobody answered for a day is
        // withdrawn, so a card lost on the way (or ignored) cannot block the Task forever.
        if (deps.now().getTime() - open.askedAt.getTime() < PROMPT_STALE_MS) return 'already_open'
        await store.withdrawProgressPrompt(open.id)
        log('progress_card_expired', { groupId, taskId: task.id, promptId: open.id })
      }
      const { prompt } = await store.createProgressPrompt({
        groupId, taskId: task.id, targetStatus: decision.status,
        subjectLineUserId: job.senderLineUserId, triggerMessageId: job.storedMessageId, askedAt: deps.now(),
      })
      if (!prompt) return 'already_open'
      try {
        await line.reply(replyToken, [
          progressCard({ prompt, task, senderName: displayName(members, job.senderLineUserId), sentAt: job.sentAt }),
        ])
      } catch (err) {
        // The group never got the buttons: withdraw the card so the next update can ask again.
        try {
          await store.withdrawProgressPrompt(prompt.id)
        } catch (withdrawErr) {
          logError('progress_withdraw_failed', { groupId, promptId: prompt.id }, withdrawErr)
        }
        throw err
      }
      log('progress_asked', { groupId, taskId: task.id, promptId: prompt.id, target: decision.status })
      return 'asked'
    }

    case 'unsure': {
      // The model's likely Tasks, plus the sender's own open Tasks even when the model gave
      // them little weight (E2E round 2, step 3.6): people mostly report their own work.
      const likely = decision.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is TaskRow => t !== undefined)
      const own = tasks.filter((t) => t.assigneeLineUserId === job.senderLineUserId && !likely.includes(t))
      const picked = pickerCandidates([...likely, ...own], decision.status, job.senderLineUserId)
      if (picked.length === 0) return 'ignored'
      await line.reply(replyToken, [pickerCard({ messageId: job.storedMessageId, tasks: picked, targetStatus: decision.status })])
      log('progress_picker', { groupId, choices: picked.length, reason: 'unsure' })
      return 'picker'
    }

    case 'failed': {
      // The model did not answer (refusal, error, the Fair-use cap, no Owner): ask the group
      // with the keyword's status. Free, no further model call.
      const status = keywordStatus
      const candidates = pickerCandidates(tasks, status, job.senderLineUserId)
      if (candidates.length === 0) return 'ignored'
      await line.reply(replyToken, [pickerCard({ messageId: job.storedMessageId, tasks: candidates, targetStatus: status })])
      log('progress_picker', { groupId, choices: candidates.length, reason: 'no_model' })
      return 'picker'
    }
  }
}
