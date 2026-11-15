import { log } from '../log'
import type { Deps } from '../ports'

/** #29: a path that assigns a Task reads the assignee as a live Member, then writes. A leave
 *  can land between the two. The leave marks the person left before it releases their Tasks
 *  (webhook/ingest.ts), so a write that landed after the release always sees them as not live
 *  here, and one that landed before it was released by the leave. Call it after the write.
 *  Returns true when the person was not live and their open Tasks in the group (the one just
 *  written among them) were released. */
export async function releaseIfLeft(
  deps: Deps,
  p: { groupId: string; lineUserId: string; event: string; taskId?: string },
): Promise<boolean> {
  // One database step: a newer join cannot land between the membership check and the release.
  const released = await deps.store.releaseTasksIfLeft({ groupId: p.groupId, lineUserId: p.lineUserId })
  if (released.length === 0) return false
  log(p.event, { groupId: p.groupId, ...(p.taskId ? { taskId: p.taskId } : {}) })
  return true
}
