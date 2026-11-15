import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { bubble, button, header, text, uri } from '../line/flex-ui'
import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log, logError } from '../log'
import type { Deps, GroupRow } from '../ports'
import { botLeaveGroup } from '../removal/leave'
import type { TickJob } from '../tick/run-tick'

// #30 part A: the Owner leaves a group.
//
// 1. The leave event (webhook/ingest.ts) calls markOwnerLeftOnLeave beside the other leave
//    writes, before the ledger row: groups.owner_left_at is set and owner_confirmed_at is
//    cleared (groups_owner_rules). From then on the Owner-backed features pause in that
//    group: file saving (#4, gated on ownerBackedOn below), Summaries (run-summary.ts) and
//    the weekly insight (listWeeklySummaryGroups skips the group). Tasks, reminders and the
//    Dashboard do not read the Owner, so they keep working.
// 2. The member_left job (members/left.ts) calls postOwnerNeededCard: one owner_needed card
//    (a task_prompts row, one open per group), posted with one push inside the push budget.
//    Its button opens the LIFF Owner page, where a live Member takes the role over
//    (setup/owner-change.ts).
//
// 3. Part B, ownerExitJob below: OWNER_EXIT_AFTER_DAYS after owner_left_at with still no
//    confirmed Owner, the bot leaves the group through botLeaveGroup (#11), which sets
//    left_at and delete_after as soon as LINE accepts the leave call, so the 7-day deletion
//    starts. A re-invite inside those 7 days clears the mark, and a re-invite to a group still
//    without a confirmed Owner resets owner_left_at to the re-invite time (markBotJoined), so
//    the count starts again.

/** Part B: days after owner_left_at before the bot leaves a group with no new Owner. */
export const OWNER_EXIT_AFTER_DAYS = 7
const DAY_MS = 86_400_000

/** Groups one tick lists; the rest wait for the next tick (every 15 minutes). */
export const OWNER_EXIT_BATCH = 50

/** Tick job, every tick. Timed from the tick's start like the purge (driveDeadline): each
 *  leave starts only while one LINE call, run to its timeout, still ends in time. A leave
 *  that throws (a LINE 5xx or timeout, or a store failure after LINE accepted) is logged and
 *  the next group goes on; the group is still listed on the next tick, which tries again
 *  (botLeaveGroup marks a group LINE answers 404 for). Posts nothing to the group. */
export const ownerExitJob: TickJob = {
  name: 'owner_exit',
  async run(deps, now) {
    const deadline = driveDeadline(now)
    const leftBefore = new Date(now.getTime() - OWNER_EXIT_AFTER_DAYS * DAY_MS)
    const groupIds = await deps.store.listOwnerlessGroups(leftBefore, OWNER_EXIT_BATCH)
    if (groupIds.length === 0) return
    let left = 0
    let failed = 0
    let complete = true
    for (const groupId of groupIds) {
      try {
        checkTime(deps, deadline, 1)
        const { outcome } = await botLeaveGroup(deps, { groupId, reason: 'no_owner', now })
        if (outcome === 'left' || outcome === 'not_in_group') left++
      } catch (err) {
        if (err instanceof DriveTimeUp) {
          complete = false
          break
        }
        failed++
        logError('owner_exit_failed', { groupId }, err)
      }
    }
    log('owner_exit_done', { due: groupIds.length, left, failed, complete })
  },
}

/** Share of the monthly quota this push leaves unspent: as small as the reminders' and the
 *  lost-access card's, because nothing else asks the group for a new Owner. */
export const OWNER_NEEDED_PUSH_RESERVE = 0.02

/** Owner-backed features (file saving, Summaries) run only while the group has a confirmed
 *  Owner. An Owner who left clears owner_confirmed_at, so this is false while
 *  owner_left_at is set. */
export function ownerBackedOn(group: Pick<GroupRow, 'ownerConfirmedAt' | 'nominatedOwnerLineUserId'>): boolean {
  return group.ownerConfirmedAt !== null && group.nominatedOwnerLineUserId !== null
}

/** At the leave event, after markMemberLeft. Returns the Owner's LINE user ID when one of
 *  `leavers` is the group's Owner who left (the card is due), else null. `group` is the row
 *  read before the leave writes.
 *  - The confirmed Owner left: owner_left_at is set now (one conditional UPDATE).
 *  - A redelivery after that write but before the ledger row reads owner_left_at already
 *    set, so it still answers the Owner and the card is not lost; the open-card index keeps
 *    it to one card.
 *  - A nominee who never confirmed is not an Owner: nothing.
 *  - A stale leave older than a rejoin left the person live: nothing. */
export async function markOwnerLeftOnLeave(deps: Deps, group: GroupRow, leavers: string[], at: Date): Promise<string | null> {
  const owner = group.nominatedOwnerLineUserId
  if (owner === null || !leavers.includes(owner)) return null
  if (group.ownerConfirmedAt === null && group.ownerLeftAt === null) return null
  if ((await deps.store.getMembership(group.id, owner)) !== 'left') return null
  if (group.ownerConfirmedAt !== null) {
    const { updated } = await deps.store.markOwnerLeft({ groupId: group.id, lineUserId: owner, at })
    if (updated) log('owner_left', { groupId: group.id })
  }
  return owner
}

export const OWNER_NEEDED_TEXT = {
  title: 'เจ้าของบอทออกจากกลุ่มแล้ว',
  body: 'น้องจดดีหยุดเก็บไฟล์และสรุปรายสัปดาห์ของกลุ่มนี้ไว้ก่อน งาน การเตือน และ Dashboard ยังใช้ได้ตามปกติ',
  ask: 'ใครจะเป็นเจ้าของบอทคนใหม่? กดปุ่มด้านล่าง เข้าสู่ระบบ LINE แล้วเชื่อม Google Drive ของตัวเอง',
  button: 'เป็นเจ้าของบอทแทน',
} as const

/** One bubble: what paused, what still works, and the button to the LIFF Owner page
 *  (`owner` view, groups.id). No names on it. */
export function ownerNeededCard(liffId: string, groupId: string): LineMessage {
  return {
    type: 'flex',
    altText: `${OWNER_NEEDED_TEXT.title} ${OWNER_NEEDED_TEXT.ask}`,
    contents: bubble(
      [
        header('warning', OWNER_NEEDED_TEXT.title),
        text(OWNER_NEEDED_TEXT.body, { color: '#545454' }),
        text(OWNER_NEEDED_TEXT.ask),
      ],
      [button('primary', uri(OWNER_NEEDED_TEXT.button, liffUrl(liffId, 'owner', groupId)))],
    ),
  }
}

export type OwnerNeededResult = GroupPushResult | 'already_open'

/** Opens the group's owner_needed card and pushes it once. A group that already has an open
 *  card (a redelivered leave, a claimer who left, or the daily member check of #32 meeting the
 *  same leave) gets no second push. A push skipped near the quota, or failed, is not sent
 *  again; the card stays open, and the Summary command's reply carries the same button
 *  (summary/run-summary.ts). */
export async function postOwnerNeededCard(
  deps: Deps, p: { groupId: string; lineGroupId: string; ownerLineUserId: string },
): Promise<OwnerNeededResult> {
  const { promptId } = await deps.store.openOwnerNeededPrompt({
    groupId: p.groupId, subjectLineUserId: p.ownerLineUserId, askedAt: deps.now(),
  })
  if (promptId === null) {
    log('owner_needed_card', { groupId: p.groupId, result: 'already_open' })
    return 'already_open'
  }
  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'owner_needed', groupId: p.groupId, lineGroupId: p.lineGroupId,
    messages: [ownerNeededCard(deps.config.liffId, p.groupId)],
    reserve: OWNER_NEEDED_PUSH_RESERVE,
    retryKey: retryKeyFrom(`owner_needed:${promptId}`),
  })
  log('owner_needed_card', { groupId: p.groupId, result })
  return result
}
