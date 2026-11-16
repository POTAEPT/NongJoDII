import { parseGroupCommand } from '../commands/parse'
import type { LineMessage } from '../line/types'
import { log, logError } from '../log'
import type { Deps, NewCandidate } from '../ports'
import { capMessage, getFairUseStatus, warnMessage } from '../usage/fair-use'
import { FairUseCapReachedError, runMeteredAi } from '../usage/meter'
import { TEXT_MODEL } from '../usage/pricing'
import { parseSummaryOutput, SUMMARY_SCHEMA, type ParsedTask } from './parse-output'
import { isTaskFeedback } from '../review/feedback'
import { ownerBackedOn, ownerNeededCard } from '../members/owner-left'
import { setupCard } from '../setup/card'
import { isSetupOpen, setupState } from '../setup/rules'
import { buildSummaryPrompt, stripMessageRefs, substituteMemberRefs } from './prompt'
import { buildSummaryReply, type ReplyCandidate } from './reply'
import { summaryFailedText, summaryFailure } from './failure'

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
    if (!sent.value) await replyText(deps, replyToken, groupId, summaryFailedText(reason, deps.now()), sent)
  }
}

async function summarize(deps: Deps, job: SummaryJob, replyToken: string, sent: { value: boolean }): Promise<void> {
  const { groupId } = job
  const { store } = deps

  const group = await store.getGroupById(groupId)
  if (!group) {
    log('summary_group_missing', { groupId })
    return
  }
  if (!group.featureSummarize) return replyText(deps, replyToken, groupId, REPLY_FEATURE_OFF, sent)
  // Owner-backed features run only with a confirmed Owner.
  if (!ownerBackedOn(group) || !group.nominatedOwnerLineUserId) {
    // #30: the Owner left. The reply (no push) carries the owner_needed card, so the group
    // can still reach the Owner page when that card's push was skipped near the quota.
    if (group.ownerLeftAt !== null) return reply(deps, replyToken, groupId, [ownerNeededCard(deps.config.liffId, groupId)], sent)
    const messages: LineMessage[] = [{ type: 'text', text: REPLY_NO_OWNER }]
    // Setup not finished (no Project yet): the #2a setup card rides on the same reply,
    // the second way to it after the join reply (#52). It reaches groups whose join reply
    // failed and groups the bot joined before onboarding existed. A group that has a
    // Project but no confirmed Owner (the Owner left) needs an Owner change, not setup.
    if (isSetupOpen(setupState(group))) messages.push(setupCard({ liffId: deps.config.liffId, groupId }))
    return reply(deps, replyToken, groupId, messages, sent)
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
  const prompt = buildSummaryPrompt({
    now: deps.now(), workDescription: group.workDescription, members, messages, context, existingTasks,
  })

  let parsed: { summary: string; tasks: ParsedTask[] }
  try {
    const result = await runMeteredAi(
      deps,
      { ownerLineUserId, projectId: group.projectId, groupId, purpose: 'summary' },
      { model: TEXT_MODEL, system: prompt.system, user: prompt.user, maxTokens: SUMMARY_MAX_TOKENS, schema: SUMMARY_SCHEMA },
    )
    parsed = parseSummaryOutput(result.content)
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
    return replyText(deps, replyToken, groupId, summaryFailedText(reason, deps.now()), sent)
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
      candidates.push({
        title, details, suggestedAssigneeLineUserId: assignee?.lineUserId ?? null, suggestedDueAt: task.due,
        // #109: a tag that carries a member or message ref is dropped (people are never tags).
        suggestedTags: task.tags.filter((tag) => !/\{m\d+\}|\bmsg\d+\b/i.test(tag)),
      })
      replyCandidates.push({
        title,
        assignee: assignee ? { displayName: assignee.displayName } : null,
        due: task.due,
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
