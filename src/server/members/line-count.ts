import { logError } from '../log'
import type { Deps } from '../ports'

// #142: LINE lists a group's members only for verified and premium accounts, so the bot
// knows a person once they send a message, join after the bot, or open a LIFF page. The
// member count works for every account, so the setup form and Settings can say how many
// people the bot does not know yet ("รู้จักแล้ว 2 จาก 5 คน").

/** The LINE member count of a group (the OA itself not counted), or null when LINE did not answer. */
export async function lineMemberCount(deps: Deps, p: { groupId: string; lineGroupId: string }): Promise<number | null> {
  try {
    return await deps.line.getGroupMemberCount(p.lineGroupId)
  } catch (err) {
    logError('line_member_count_failed', { groupId: p.groupId }, err)
    return null
  }
}
