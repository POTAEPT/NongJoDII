import { log, logError } from '../log'
import type { Deps } from '../ports'
import { setupCard } from './card'

// #52: the bot joined a group. It answers with the #2a setup card (a reply: free, no push)
// and stores the group's name from LINE. The two steps are independent: a slow or failed
// name lookup never costs the reply token, and a failed reply still stores the name.
// Setup data already saved (a re-invite) is left as it is; left_at and delete_after of a
// re-invite belong to #11.

export async function handleJoin(
  deps: Deps,
  job: { groupId: string; lineGroupId: string; replyToken: string | null },
): Promise<void> {
  const { groupId, lineGroupId, replyToken } = job
  await Promise.all([
    (async () => {
      if (!replyToken) return
      try {
        await deps.line.reply(replyToken, [setupCard({ liffId: deps.config.liffId, groupId })])
        log('setup_card_replied', { groupId })
      } catch (err) {
        logError('setup_card_failed', { groupId }, err)
      }
    })(),
    (async () => {
      // Best effort: the form and the cards read fine without the name.
      try {
        const summary = await deps.line.getGroupSummary(lineGroupId)
        if (summary) await deps.store.setGroupName(groupId, summary.groupName)
      } catch (err) {
        logError('group_name_failed', { groupId }, err)
      }
    })(),
  ])
}
