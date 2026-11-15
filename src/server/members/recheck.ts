import { log } from '../log'
import type { Deps } from '../ports'

/** #29: a path that assigns a Task reads the assignee as a live Member, then writes. A leave
 *  can land between the two. The leave marks the person left before it releases their Tasks
 *  (webhook/ingest.ts), so a write that landed after the release always sees them as not live
 *  here, and one that landed before it was released by the leave. Call it after the write.
 *  Returns true when the person had left and their open Tasks in the group were released. */
export async function releaseIfLeft(
  deps: Deps,
  p: { groupId: string; lineUserId: string; event: string; taskId?: string },
): Promise<boolean> {
  if ((await deps.store.getMembership(p.groupId, p.lineUserId)) === 'live') return false
  await deps.store.releaseTasksOf({ groupId: p.groupId, lineUserId: p.lineUserId })
  log(p.event, { groupId: p.groupId, ...(p.taskId ? { taskId: p.taskId } : {}) })
  return true
}
