import { parseGroupCommand } from '@/server/commands/parse'
import { sendConnectDriveCard } from '@/server/google/connect-card'
import { logError } from '@/server/log'
import type { Deps } from '@/server/ports'
import { runSummaryCommand } from '@/server/summary/run-summary'
import type { Job } from './ingest'

export async function processJobs(deps: Deps, jobs: Job[]): Promise<void> {
  for (const job of jobs) {
    try {
      await processJob(deps, job)
    } catch (err) {
      logError('webhook_job_failed', { kind: job.kind }, err)
    }
  }
}

async function processJob(deps: Deps, job: Job): Promise<void> {
  if (job.kind === 'group_message') {
    const { senderLineUserId, lineGroupId, groupId, replyToken } = job
    if (senderLineUserId) {
      // Best effort: a LINE 5xx/429 here must not stop the command below from running.
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
    if (parseGroupCommand(job.text) === 'summarize') {
      await runSummaryCommand(deps, { groupId, lineGroupId, replyToken, requesterLineUserId: senderLineUserId })
    }
    return
  }
  await sendConnectDriveCard(deps, job)
}
