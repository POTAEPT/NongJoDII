import { sendConnectDriveCard } from '@/server/google/connect-card'
import { logError } from '@/server/log'
import type { Deps } from '@/server/ports'
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
    const { senderLineUserId, lineGroupId } = job
    if (senderLineUserId) {
      const user = await deps.store.findLineUser(senderLineUserId)
      if (!user?.displayName) {
        const profile = await deps.line.getGroupMemberProfile(lineGroupId, senderLineUserId)
        if (profile) await deps.store.upsertLineUser({ lineUserId: senderLineUserId, displayName: profile.displayName })
      }
    }
    // Task 7: Summary command
    return
  }
  await sendConnectDriveCard(deps, job)
}
