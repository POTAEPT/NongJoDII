import { parseGroupCommand } from '../commands/parse'
import type { LineMessage } from '../line/types'
import { log, logError } from '../log'
import type { Deps, NewCandidate } from '../ports'
import { capMessage, getFairUseStatus, warnMessage } from '../usage/fair-use'
import { FairUseCapReachedError, runMeteredAi } from '../usage/meter'
import { TEXT_MODEL } from '../usage/pricing'
import { parseSummaryOutput, settleMidnightDue, settleWeekdayDue, SUMMARY_SCHEMA, type ParsedTask, ModelOutputError } from './parse-output'
import { isTaskFeedback } from '../review/feedback'
import { ownerBackedOn, ownerNeededCard } from '../members/owner-left'
import { nextStepCard, uri } from '../line/flex-ui'
import { liffUrl } from '../liff-links'
import { isSetupOpen, setupState } from '../setup/rules'
import { buildSummaryPrompt, COUNT_IS_PROJECT_WORK, stripMessageRefs, substituteMemberRefs } from './prompt'
import { buildSummaryReply, type ReplyCandidate } from './reply'
import { summaryFailedCard, summaryFailure } from './failure'
import { COUNT_HINT, COUNT_MIN, precheckSummary } from './precheck'

/** One time budget for the whole Summary, counted from the start of its work: the webhook
 *  route's maxDuration is 60 s and the reply token must still be valid when the answer goes. */
export const SUMMARY_BUDGET_MS = 50_000
/** A text call's own cap (the OpenRouter client's default); each call gets min(cap, time left). */
export const SUMMARY_TEXT_TIMEOUT_MS = 45_000
/** Below this much time left, the Jev pre-check is skipped and the single text call runs. */
export const SUMMARY_PRECHECK_MIN_LEFT_MS = 30_000
/** Below this much time left, no second text call (retry or plain prompt). */
export const SUMMARY_SECOND_CALL_MIN_LEFT_MS = 15_000

/** The budget ran out before a text call could start: it fails like a timed-out call
 *  (name TimeoutError, so summaryFailure gives ai_timeout). */
class SummaryBudgetSpentError extends Error {
  name = 'TimeoutError'
}

export type SummaryJob = { groupId: string; lineGroupId: string; replyToken: string | null; requesterLineUserId: string | null }

export const SUMMARY_MESSAGE_LIMIT = 100
/** #108: chat an earlier Summary already covered, sent as context only. */
export const SUMMARY_CONTEXT_LIMIT = 20
/** #108: the existing Tasks the model is told not to repeat: open ones, and Done ones from
 *  this many days back, at most SUMMARY_TASKS_LIMIT. */
export const SUMMARY_DONE_DAYS = 30
export const SUMMARY_TASKS_LIMIT = 50
const SUMMARY_MAX_TOKENS = 4000
const TITLE_MAX = 200
const DETAILS_MAX = 2000

const REPLY_FEATURE_OFF = 'ฟีเจอร์สรุปแชตปิดอยู่ในกลุ่มนี้ เปิดได้ที่การตั้งค่า'
const REPLY_NO_OWNER = 'กลุ่มนี้ยังไม่มีเจ้าของกลุ่มที่ยืนยันแล้ว จึงยังสรุปแชตไม่ได้ กรุณาตั้งค่ากลุ่มให้เสร็จก่อน'
const REPLY_NO_MESSAGES = 'ยังไม่มีข้อความให้สรุป'
export const SUMMARY_CARD_TEXT = {
  offTitle: 'ฟีเจอร์สรุปแชตปิดอยู่',
  offBody: 'เจ้าของบอทเปิดได้ในหน้าการตั้งค่า',
  settingsButton: 'เปิดการตั้งค่า',
  noOwnerTitle: 'กลุ่มนี้ยังไม่มีเจ้าของบอท',
  noOwnerBody: 'ต้องมีเจ้าของบอทก่อน น้องจดดีถึงจะสรุปแชตได้',
  setupButton: 'ตั้งค่ากลุ่ม',
} as const
export const REPLY_NOTHING_NEW = 'ยังไม่มีข้อความใหม่ตั้งแต่สรุปครั้งก่อน คุยต่อแล้วค่อยสั่งสรุปอีกครั้งนะ'

/** "NongJoDII summarize": summarizes recent chat into a Summary with Task candidates
 *  (proposals only; a Task exists only after confirm) and replies in the group that asked. */
export async function runSummaryCommand(deps: Deps, job: SummaryJob): Promise<void> {
  const { replyToken, groupId } = job
  if (!replyToken) return
  // Reply token is single-use: once any reply was attempted, the failure notice must not try again.
  const sent = { value: false }
  try {
    await summarize(deps, job, replyToken, sent)
  } catch (err) {
    // A store failure outside the AI step (group, usage, messages, members, createSummary) must still answer the group.
    const reason = summaryFailure(err, false)
    logError('summary_failed', { groupId, reason }, err)
    if (!sent.value) await reply(deps, replyToken, groupId, [summaryFailedCard(reason, deps.now())], sent)
  }
}

async function summarize(deps: Deps, job: SummaryJob, replyToken: string, sent: { value: boolean }): Promise<void> {
  const { groupId } = job
  const { store } = deps
  // Same clock as the other deadlines (files/save.ts): deps.now().
  const deadline = deps.now().getTime() + SUMMARY_BUDGET_MS
  const timeLeft = () => deadline - deps.now().getTime()

  const group = await store.getGroupById(groupId)
  if (!group) {
    log('summary_group_missing', { groupId })
    return
  }
  if (!group.featureSummarize) {
    // UX review 2.1: a card with the button to Settings, not only words.
    return reply(deps, replyToken, groupId, [nextStepCard({
      tone: 'info', title: SUMMARY_CARD_TEXT.offTitle, body: SUMMARY_CARD_TEXT.offBody, altText: REPLY_FEATURE_OFF,
      button: uri(SUMMARY_CARD_TEXT.settingsButton, liffUrl(deps.config.liffId, 'settings', groupId)),
    })], sent)
  }
  // Owner-backed features run only with a confirmed Owner.
  if (!ownerBackedOn(group) || !group.nominatedOwnerLineUserId) {
    // #30: the Owner left. The reply (no push) carries the owner_needed card, so the group
    // can still reach the Owner page when that card's push was skipped near the quota.
    if (group.ownerLeftAt !== null) return reply(deps, replyToken, groupId, [ownerNeededCard(deps.config.liffId, groupId)], sent)
    // Setup not finished (no Project yet): one card with the button to the setup form, the
    // second way to it after the join reply (#52). It reaches groups whose join reply failed
    // and groups the bot joined before onboarding existed (UX review 2.1: before, a text plus
    // the whole #2a setup card). A group that has a Project but no confirmed Owner needs an
    // Owner change, not setup: words only.
    const open = isSetupOpen(setupState(group))
    return reply(deps, replyToken, groupId, [nextStepCard({
      tone: 'warning', title: SUMMARY_CARD_TEXT.noOwnerTitle, body: SUMMARY_CARD_TEXT.noOwnerBody, altText: REPLY_NO_OWNER,
      ...(open ? { button: uri(SUMMARY_CARD_TEXT.setupButton, liffUrl(deps.config.liffId, 'setup', groupId)) } : {}),
    })], sent)
  }
  const ownerLineUserId = group.nominatedOwnerLineUserId

  // Fair-use cap: a capped Owner gets the cap message only (no AI call, no usage, no Summary).
  // This read is not race-safe by itself; the usage claim in runMeteredAi is the real gate.
  const before = await getFairUseStatus(store, ownerLineUserId, deps.now())
  if (before.level === 'capped') return reply(deps, replyToken, groupId, [capMessage(before)], sent)

  // #108: a Summary covers only the chat since the group's last one (summaries.last_message_at);
  // up to SUMMARY_CONTEXT_LIMIT earlier messages go along as context only. The first Summary
  // of a group covers the last SUMMARY_MESSAGE_LIMIT messages, as before.
  const lastEnd = await store.getLatestSummaryEnd(groupId)
  // The command message itself is already stored and takes one slot (M1).
  const recent = (await store.listRecentTextMessages(groupId, SUMMARY_MESSAGE_LIMIT + SUMMARY_CONTEXT_LIMIT + 1))
    // Commands and the "Tasks created" messages a LIFF page posted are not chat to summarize.
    .filter((m) => parseGroupCommand(m.text) === null && !isTaskFeedback(m.text))
  const isNew = (m: { sentAt: Date }) => lastEnd === null || m.sentAt.getTime() > lastEnd.getTime()
  const messages = recent.filter(isNew).slice(-SUMMARY_MESSAGE_LIMIT)
  const context = lastEnd === null ? [] : recent.filter((m) => !isNew(m)).slice(-SUMMARY_CONTEXT_LIMIT)
  if (messages.length === 0) {
    // Nothing since the last Summary: no AI call, no Summary.
    return replyText(deps, replyToken, groupId, lastEnd === null ? REPLY_NO_MESSAGES : REPLY_NOTHING_NEW, sent)
  }

  const members = await store.listLiveMembers(groupId)
  const doneSince = new Date(deps.now().getTime() - SUMMARY_DONE_DAYS * 86_400_000)
  const existingTasks = (await store.listTasksForSummary(groupId, doneSince, SUMMARY_TASKS_LIMIT))
    .map((t) => ({ title: t.title, status: t.status, tags: t.tags }))
  // #110: the group's starting tags (Settings), which the model picks from first.
  const groupTags = (await store.getGroupSetup(groupId))?.tagSet ?? []
  const promptInput = { now: deps.now(), workDescription: group.workDescription, members, messages, context, existingTasks, groupTags }
  const meter = { ownerLineUserId, projectId: group.projectId, groupId }
  // #157: Jev reads the same chat first (null = no usable answer: as before). Skipped when
  // Draft tasks is off, since no Task would be kept anyway, and when too little time is left.
  const checkLeft = timeLeft()
  const check = group.featureDraftTasks && checkLeft >= SUMMARY_PRECHECK_MIN_LEFT_MS
    ? await precheckSummary(deps, meter, buildSummaryPrompt(promptInput).chat, checkLeft)
    : null
  const prompt = buildSummaryPrompt({
    ...promptInput,
    precheck: check === null ? null
      : check.hasTask === false ? { noTask: true }
        : check.count !== null ? { noTask: false, countHint: COUNT_HINT[check.count] } : null,
  })
  const askModel = async (user: string) => {
    const left = timeLeft()
    if (left <= 0) throw new SummaryBudgetSpentError('summary time budget spent')
    return parseSummaryOutput((await runMeteredAi(
      deps, { ...meter, purpose: 'summary' },
      {
        model: TEXT_MODEL, system: prompt.system, user, maxTokens: SUMMARY_MAX_TOKENS, schema: SUMMARY_SCHEMA,
        timeoutMs: Math.min(SUMMARY_TEXT_TIMEOUT_MS, left),
      },
    )).content)
  }
  const secondCallFits = () => timeLeft() >= SUMMARY_SECOND_CALL_MIN_LEFT_MS

  let parsed: { summary: string; tasks: ParsedTask[] }
  let mayHaveMore = false
  // The prompt without Jev's line: the old Summary prompt (the same refs, so the same answer shape).
  const plainUser = buildSummaryPrompt(promptInput).user
  try {
    let secondUsed = false
    try {
      parsed = await askModel(prompt.user)
    } catch (err) {
      // #157: an unreadable answer to the prompt with Jev's line: the second (last) text call
      // goes out as the old prompt, so the hint never costs the group its Summary.
      // Too little time left for it: the unreadable answer fails as before.
      if (!(err instanceof ModelOutputError) || plainUser === prompt.user || !secondCallFits()) throw err
      log('summary_hint_unreadable', { groupId })
      parsed = await askModel(plainUser)
      secondUsed = true
    }
    // #157: fewer Tasks than Jev counted: one retry for the missing ones (at most 2 text calls),
    // when the time left allows it. The retry's new Tasks are added to the first answer's.
    const count = check?.hasTask === true ? check.count : null
    const wanted = count !== null ? COUNT_MIN[count] : 0
    if (count !== null && parsed.tasks.length < wanted) {
      if (!secondUsed && secondCallFits()) {
        try {
          const again = await askModel(retryUser(prompt.user, parsed.tasks, COUNT_HINT[count]))
          parsed = { ...parsed, tasks: mergeTasks(parsed.tasks, again.tasks) }
        } catch (err) {
          if (err instanceof FairUseCapReachedError) throw err
          logError('summary_retry_failed', { groupId }, err)
        }
        log('summary_retry', { groupId, wanted, got: parsed.tasks.length })
      } else if (!secondUsed) {
        log('summary_retry_skipped', { groupId, wanted, got: parsed.tasks.length })
      }
      mayHaveMore = parsed.tasks.length < wanted
    }
    // #157: Jev found no work: the summary only, whatever the text model listed.
    if (check?.hasTask === false) parsed = { ...parsed, tasks: [] }
  } catch (err) {
    // The pre-check passed but another request for this Owner claimed the rest of the cap
    // first: same cap reply, no AI call was made, no Summary.
    if (err instanceof FairUseCapReachedError) {
      return reply(deps, replyToken, groupId, [capMessage(await getFairUseStatus(store, ownerLineUserId, deps.now()))], sent)
    }
    // Any error: AdapterError, a raw TimeoutError/SyntaxError from the client, or ModelOutputError.
    // The reply says why, with a code and the time to find this log line (summary/failure.ts).
    const reason = summaryFailure(err, true)
    logError('summary_ai_failed', { groupId, reason }, err)
    return reply(deps, replyToken, groupId, [summaryFailedCard(reason, deps.now())], sent)
  }

  // H1: the model writes {mN}; code swaps in LINE names, so a nickname never reaches a screen.
  const liveById = new Map(members.map((m) => [m.lineUserId, m]))
  const nameByRef = new Map<string, string | null>()
  const userByRef = new Map<string, string>()
  for (const { ref, lineUserId } of prompt.memberRefs) {
    userByRef.set(ref, lineUserId)
    const live = liveById.get(lineUserId)
    nameByRef.set(
      ref,
      live ? live.displayName : (messages.find((m) => m.senderLineUserId === lineUserId)?.senderDisplayName ?? null),
    )
  }
  const messageByRef = new Map(prompt.messageRefs.map((r) => [r.ref, r.message]))
  // The model may still leak a message ref (msg14) into text people read: strip it
  // from the model's text first, so a LINE name that looks like a ref is never cut.
  const readable = (text: string) => substituteMemberRefs(stripMessageRefs(text), nameByRef)
  const summaryText = readable(parsed.summary)

  const candidates: NewCandidate[] = []
  const replyCandidates: ReplyCandidate[] = []
  // M4: with Draft tasks off, the model's tasks are ignored.
  if (group.featureDraftTasks) {
    for (const task of parsed.tasks) {
      const title = readable(task.title).trim().slice(0, TITLE_MAX)
      if (title === '') continue
      const details = task.details === null
        ? null
        : readable(task.details).trim().slice(0, DETAILS_MAX) || null
      // Never trust raw model output: only a live Member can be the suggested assignee.
      const refUser = task.assigneeRef ? userByRef.get(task.assigneeRef) : undefined
      const assignee = refUser ? liveById.get(refUser) : undefined
      const source = task.sourceRef ? messageByRef.get(task.sourceRef) : undefined
      // A T00:00 due is 23:59 that day unless the Task's message (or, with no source, the
      // chat) speaks of midnight.
      const settled = settleMidnightDue(task.due, source ? source.text : messages.map((m) => m.text).join('\n'))
      // A weekday in the Task's own message ("ส่งวันพฤหัส") fixes the day the model counted
      // wrong, against the same "now" as the prompt's calendar.
      const due = settleWeekdayDue(settled, source ? source.text : null, promptInput.now)
      candidates.push({
        title, details, suggestedAssigneeLineUserId: assignee?.lineUserId ?? null, suggestedDueAt: due,
        // #109: a tag that carries a member or message ref is dropped (people are never tags).
        suggestedTags: task.tags.filter((tag) => !/\{m\d+\}|\bmsg\d+\b/i.test(tag)),
      })
      replyCandidates.push({
        title,
        assignee: assignee ? { displayName: assignee.displayName } : null,
        due,
        source: source ? { senderName: source.senderDisplayName, sentAt: source.sentAt } : null,
      })
    }
  }

  const { summaryId } = await store.createSummary(
    {
      groupId,
      requestedByLineUserId: job.requesterLineUserId,
      summaryText,
      firstMessageAt: messages[0].sentAt,
      lastMessageAt: messages[messages.length - 1].sentAt,
      createdAt: deps.now(),
    },
    candidates,
  )

  const replyMessages = buildSummaryReply({
    summaryText, candidates: replyCandidates, summaryId, liffId: deps.config.liffId, draftTasks: group.featureDraftTasks,
    mayHaveMore,
  })
  // This call may have crossed 80% or the cap; the notice rides on the same reply (no pushes).
  try {
    const after = await getFairUseStatus(store, ownerLineUserId, deps.now())
    if (after.level === 'capped') replyMessages.push(capMessage(after))
    else if (
      after.level === 'warn' &&
      (await store.claimFairUseNotice({ ownerLineUserId, groupId, monthStartBkk: after.monthStartBkk, kind: 'warn_80' })).inserted
    ) {
      replyMessages.push(warnMessage(after))
    }
  } catch (err) {
    logError('summary_fair_use_notice_failed', { groupId }, err)
  }
  await reply(deps, replyToken, groupId, replyMessages, sent)
}

function replyText(deps: Deps, replyToken: string, groupId: string, text: string, sent: { value: boolean }): Promise<void> {
  return reply(deps, replyToken, groupId, [{ type: 'text', text }], sent)
}

/** A reply failure is logged, not retried (the reply token is single-use). */
async function reply(
  deps: Deps, replyToken: string, groupId: string, messages: LineMessage[], sent: { value: boolean },
): Promise<void> {
  sent.value = true
  try {
    await deps.line.reply(replyToken, messages)
  } catch (err) {
    logError('summary_reply_failed', { groupId }, err)
  }
}

/** #157: the retry's user part: the first answer's titles and the count Jev found. */
export function retryUser(user: string, first: ParsedTask[], countHint: string): string {
  const listed = first.length === 0 ? 'no tasks' : first.map((t) => `- ${t.title.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
  return [
    user,
    '',
    `Your first answer listed ${first.length} task(s):`,
    listed,
    `A first reading found ${countHint} separate pieces of work. Re-read the Chat and answer the complete JSON again, with every separate piece of work as its own task. Keep the tasks above and add any missing ones. Do not split one job into parts and never invent work. ${COUNT_IS_PROJECT_WORK}`,
  ].join('\n')
}

/** #157: the retry merges: every first-answer Task stays, and a retry Task is added unless it is
 *  already there. Two Tasks are the same when their titles match after trim, space collapse and
 *  lowercase, and, when both name a source message, it is the same message. */
export function mergeTasks(first: ParsedTask[], retry: ParsedTask[]): ParsedTask[] {
  const key = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase()
  const merged = [...first]
  for (const task of retry) {
    const same = merged.some((t) =>
      key(t.title) === key(task.title) && (t.sourceRef === null || task.sourceRef === null || t.sourceRef === task.sourceRef))
    if (!same) merged.push(task)
  }
  return merged
}
