import { parseGroupCommand } from '@/server/commands/parse'
import { sendConnectDriveCard } from '@/server/google/connect-card'
import { log, logError } from '@/server/log'
import type { Deps } from '@/server/ports'
import { handleProgressPostback } from '@/server/progress/handle-postback'
import { handleProgressText } from '@/server/progress/handle-text'
import { handleReminderCommand, handleReminderPostback } from '@/server/reminders/answer'
import { parseReminderAction } from '@/server/reminders/postback'
import { handleJoin } from '@/server/setup/join'
import { runSummaryCommand } from '@/server/summary/run-summary'
import type { Job } from './ingest'

/** Jobs of one webhook that run at the same time.
 *  Time budget: the whole batch runs inside one after() call of the webhook route
 *  (maxDuration 60 s). A job's slowest step is one model call, which the OpenRouter
 *  adapter cuts at 45 s; its store calls, the reply and a wait of at most NAME_WAIT_MS
 *  for the sender-name refresh use the rest (the LINE client cuts each call at 10 s).
 *  Run one after another, two slow Summaries already pass 60 s, so jobs run together. A job beyond this limit waits for a free slot and could then run out
 *  of time, so the limit sits above any realistic batch: LINE sends a group's events
 *  in small batches, and commands (the only slow jobs) are rare among them.
 *  No queue (rules: Webhook). */
export const JOB_CONCURRENCY = 10

/** How long a Summary waits for this batch's sender-name refresh before it runs
 *  anyway. The refresh only fills in names for people whose messages arrived in this
 *  batch; a Summary without them falls back to the stored names. */
export const NAME_WAIT_MS = 3_000

export async function processJobs(deps: Deps, jobs: Job[]): Promise<void> {
  if (jobs.length > JOB_CONCURRENCY) {
    log('webhook_batch_over_limit', { jobs: jobs.length, limit: JOB_CONCURRENCY })
  }
  // Names refresh in the background (each LINE call is cut by the client's timeout).
  // Only a Summary waits for them, and at most NAME_WAIT_MS; every other job starts now.
  const names = runAll(jobs, (job) => refreshSenderName(deps, job))
  let timer: ReturnType<typeof setTimeout> | undefined
  const namesOrTimeout = Promise.race([names, new Promise<void>((resolve) => { timer = setTimeout(resolve, NAME_WAIT_MS) })])
  try {
    await Promise.all([names, runAll(jobs, (job) => runJob(deps, job, namesOrTimeout))])
  } finally {
    clearTimeout(timer)
  }
}

/** Runs `fn` over every job, at most JOB_CONCURRENCY at a time. One job's failure is
 *  logged and never stops the others. */
async function runAll(jobs: Job[], fn: (job: Job) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next]
      next += 1
      try {
        await fn(job)
      } catch (err) {
        logError('webhook_job_failed', { kind: job.kind }, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, jobs.length) }, worker))
}

/** Best effort: a LINE 5xx/429 here must not stop the job's command from running. */
async function refreshSenderName(deps: Deps, job: Job): Promise<void> {
  // The sender of a group message, or the person who pressed a button in a group.
  const senderLineUserId =
    job.kind === 'group_message' ? job.senderLineUserId : job.kind === 'group_postback' ? job.userId : null
  if (job.kind === 'user_chat' || job.kind === 'group_join' || !senderLineUserId) return
  const { lineGroupId } = job
  try {
    const user = await deps.store.findLineUser(senderLineUserId)
    if (!user?.displayName) {
      const profile = await deps.line.getGroupMemberProfile(lineGroupId, senderLineUserId)
      if (profile) await deps.store.upsertLineUser({ lineUserId: senderLineUserId, displayName: profile.displayName })
    }
  } catch (err) {
    logError('line_name_refresh_failed', { lineGroupId }, err)
  }
}

async function runJob(deps: Deps, job: Job, namesReady: Promise<void>): Promise<void> {
  if (job.kind === 'group_message') {
    const { senderLineUserId, lineGroupId, groupId, replyToken, text } = job
    const command = parseGroupCommand(text)
    if (command === 'summarize') {
      await namesReady
      await runSummaryCommand(deps, { groupId, lineGroupId, replyToken, requesterLineUserId: senderLineUserId })
      return
    }
    // Typed fallbacks for the reminder buttons (#45). A command is never read as progress.
    if (command === 'done' || command === 'need_time') {
      if (replyToken && senderLineUserId) {
        await namesReady
        await handleReminderCommand(deps, { groupId, userId: senderLineUserId, command, replyToken })
      }
      return
    }
    // Any other text line may report progress on a Task (#7). Its card shows the sender's name.
    if (text && replyToken && senderLineUserId) {
      await namesReady
      await handleProgressText(deps, {
        groupId, storedMessageId: job.storedMessageId, senderLineUserId, text, sentAt: job.sentAt, replyToken,
      })
    }
    return
  }
  if (job.kind === 'group_postback') {
    if (job.replyToken) {
      await namesReady
      // Reminder buttons (#45) and progress cards (#7) use different `a` codes.
      if (parseReminderAction(job.data)) {
        await handleReminderPostback(deps, {
          groupId: job.groupId, userId: job.userId, data: job.data, pickedDate: job.pickedDate, replyToken: job.replyToken,
        })
      } else {
        await handleProgressPostback(deps, { groupId: job.groupId, userId: job.userId, data: job.data, replyToken: job.replyToken })
      }
    }
    return
  }
  if (job.kind === 'group_join') {
    await handleJoin(deps, job)
    return
  }
  await sendConnectDriveCard(deps, job)
}
