import { checkTime, driveDeadline, DriveTimeUp } from '../google/drive-folders'
import { bubble, button, header, text, uri } from '../line/flex-ui'
import { pushToGroupWithinBudget, retryKeyFrom, type GroupPushResult } from '../line/push-budget'
import type { LineMessage } from '../line/types'
import { liffUrl } from '../liff-links'
import { log, logError } from '../log'
import type { Deps, GroupRow, OwnerlessGroup } from '../ports'
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
//    confirmed Owner (decided 2026-11-15 for Sub groups):
//    - A Sub group (attached, not the main group) detaches from its Project instead: no
//      Project, no folder ID, no nominee, owner_left_at = now (one UPDATE), and a fresh
//      owner_needed card. Every detach that leaves a group with no confirmed Owner (this one,
//      #31's take-over expiry and the new Owner's "detach" answer) clears the nominee, so any
//      live Member can claim the role, the previous Owner included (decided 2026-11-15,
//      option B).
//      As a group with no Project a Member can now take the Owner role (setup/owner-change.ts:
//      LINE login, then Drive; this creates its own Project). If nobody does within 7 more
//      days, the next rule applies to it.
//    - Any other group (a main group, or a group with no Project): the bot leaves through
//      botLeaveGroup (#11), which sets left_at and delete_after as soon as LINE accepts the
//      leave call, so the 7-day deletion starts. A re-invite inside those 7 days clears the
//      mark, and a re-invite to a group still without a confirmed Owner resets owner_left_at
//      to the re-invite time (markBotJoined), so the count starts again.

/** Part B: days after owner_left_at before the bot leaves a group with no new Owner. */
export const OWNER_EXIT_AFTER_DAYS = 7
const DAY_MS = 86_400_000

/** Groups one tick works through at most. */
export const OWNER_EXIT_BATCH = 50
/** Due groups one tick reads (one PostgREST page). Beyond it the oldest wait. */
export const OWNER_EXIT_SCAN = 1000
/** How far the start of the batch moves on each 15-minute tick: the number of slow LINE
 *  calls (10 s timeout) that fit in one tick. So groups that keep failing at the head of the
 *  list cannot starve the rest: every due group is inside the batch window within
 *  ceil(n / 5) ticks. */
export const OWNER_EXIT_ROTATE_STEP = 5
const TICK_MS = 15 * 60_000

/** LINE calls of one step, as checkTime counts them: a leave is one call; a Sub group's card
 *  is two (the member count and quota reads run together, then the push). */
const LEAVE_CALLS = 1
const CARD_CALLS = 2

/** The batch of this tick: up to OWNER_EXIT_BATCH groups, starting OWNER_EXIT_ROTATE_STEP
 *  further along the list on each tick (no column needed to remember attempts). */
export function rotateForTick<T>(items: T[], now: Date): T[] {
  if (items.length === 0) return items
  const start = (Math.floor(now.getTime() / TICK_MS) * OWNER_EXIT_ROTATE_STEP) % items.length
  return [...items.slice(start), ...items.slice(0, start)].slice(0, OWNER_EXIT_BATCH)
}

/** How long an open claim holds the exit (decided 2026-11-15, option A): a Member who pressed
 *  the owner_needed card gets this long from the press to connect Drive. */
export const OWNER_CLAIM_HOLD_MS = 24 * 60 * 60_000

/** 'go': the group is still as listed (no Owner confirmed since, the same owner_left_at, which
 *  a re-invite resets, the bot still in and not re-invited since, the same kind of group).
 *  'held': as listed, but a nominee's claim is open (named less than OWNER_CLAIM_HOLD_MS ago,
 *  not confirmed); the next tick after the hold acts. 'changed': skip it. Read right before
 *  the step, because a step can start up to about 45 s after the list. */
async function exitCheck(deps: Deps, g: OwnerlessGroup, at: Date): Promise<'go' | 'held' | 'changed'> {
  const s = await deps.store.getOwnerExitState(g.groupId)
  const asListed = s !== null && s.ownerConfirmedAt === null && s.leftAt === null && s.subGroup === g.subGroup &&
    s.ownerLeftAt?.getTime() === g.ownerLeftAt.getTime() && (s.joinedAt?.getTime() ?? null) === (g.joinedAt?.getTime() ?? null)
  if (!asListed) return 'changed'
  if (s.ownerNominatedAt !== null && at.getTime() - s.ownerNominatedAt.getTime() < OWNER_CLAIM_HOLD_MS) return 'held'
  return 'go'
}

/** Tick job, every tick. Timed from the tick's start like the purge (driveDeadline): each
 *  step starts only while its LINE calls, run to their timeout, still end in time. Each
 *  group is read again right before its step and skipped if it changed (a new Owner, a
 *  re-invite) or held while a nominee's claim is open (at most 24 h after the press); the
 *  step uses the time it runs at, not the tick's start.
 *  - Leave: one that throws (a LINE 5xx or timeout, or a store failure after LINE accepted)
 *    is logged and the next group goes on; the group is still listed on the next tick,
 *    which tries again (botLeaveGroup marks a group LINE answers 404 for). Posts nothing.
 *  - Sub group: the detach is one conditional UPDATE, so a failure before it is retried on
 *    the next tick and a group already detached is never detached again. Only the run that
 *    detached posts the card, so it is posted once; a card that is then skipped (quota) or
 *    fails is not sent again (best effort, as #31's detach cards): the Summary command still
 *    replies with it.
 *  Known limit: the re-read and LINE's leave call are not one step, so a confirm in the
 *  moment between them still loses the group; the window is one store read wide. */
export const ownerExitJob: TickJob = {
  name: 'owner_exit',
  async run(deps, now) {
    const deadline = driveDeadline(now)
    const leftBefore = new Date(now.getTime() - OWNER_EXIT_AFTER_DAYS * DAY_MS)
    const due = await deps.store.listOwnerlessGroups(leftBefore, OWNER_EXIT_SCAN)
    if (due.length === 0) return
    const batch = rotateForTick(due, now)
    let left = 0
    let detached = 0
    let skipped = 0
    let held = 0
    let failed = 0
    let complete = true
    for (const g of batch) {
      try {
        checkTime(deps, deadline, g.subGroup ? CARD_CALLS : LEAVE_CALLS)
        const at = deps.now()
        const check = await exitCheck(deps, g, at)
        if (check !== 'go') {
          if (check === 'held') held++
          else skipped++
          continue
        }
        if (g.subGroup) {
          if (await detachSubGroup(deps, g, new Date(at.getTime() - OWNER_EXIT_AFTER_DAYS * DAY_MS), at)) detached++
          continue
        }
        const { outcome } = await botLeaveGroup(deps, { groupId: g.groupId, reason: 'no_owner', now: at })
        if (outcome === 'left' || outcome === 'not_in_group') left++
      } catch (err) {
        if (err instanceof DriveTimeUp) {
          complete = false
          break
        }
        failed++
        logError('owner_exit_failed', { groupId: g.groupId }, err)
      }
    }
    log('owner_exit_done', { due: due.length, batch: batch.length, left, detached, held, skipped, failed, complete })
  },
}

/** A Sub group with no Owner for 7 days leaves its Project and starts again as a group of
 *  its own. true: this call detached it (and posted the card). */
async function detachSubGroup(deps: Deps, g: OwnerlessGroup, leftBefore: Date, now: Date): Promise<boolean> {
  const { detached } = await deps.store.detachOwnerlessSubGroup(g.groupId, leftBefore, now)
  if (!detached) return false
  log('owner_exit_detached', { groupId: g.groupId })
  // The detach cleared the nominee (option B): the card asks every live Member.
  await postOwnerNeededCard(deps, { groupId: g.groupId, lineGroupId: g.lineGroupId, ownerLineUserId: null, renewedAt: now })
  return true
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
  deps: Deps, p: { groupId: string; lineGroupId: string; ownerLineUserId: string | null; renewedAt?: Date },
): Promise<OwnerNeededResult> {
  const { promptId } = await deps.store.openOwnerNeededPrompt({
    groupId: p.groupId, subjectLineUserId: p.ownerLineUserId, askedAt: deps.now(),
  })
  // renewedAt (#30 part B, a Sub group just detached): the card goes out again even though
  // the group's card is still open; the caller's detach makes this happen once.
  if (promptId === null && !p.renewedAt) {
    log('owner_needed_card', { groupId: p.groupId, result: 'already_open' })
    return 'already_open'
  }
  const result = await pushToGroupWithinBudget(deps, {
    purpose: 'owner_needed', groupId: p.groupId, lineGroupId: p.lineGroupId,
    messages: [ownerNeededCard(deps.config.liffId, p.groupId)],
    reserve: OWNER_NEEDED_PUSH_RESERVE,
    retryKey: retryKeyFrom(p.renewedAt ? `owner_needed:${p.groupId}:${p.renewedAt.toISOString()}` : `owner_needed:${promptId}`),
  })
  log('owner_needed_card', { groupId: p.groupId, result })
  return result
}
