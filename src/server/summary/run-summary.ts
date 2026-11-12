import { parseGroupCommand } from '../commands/parse'
import type { LineMessage } from '../line/types'
import { log, logError } from '../log'
import type { Deps, NewCandidate } from '../ports'
import { capMessage, getFairUseStatus, warnMessage } from '../usage/fair-use'
import { FairUseCapReachedError, runMeteredAi } from '../usage/meter'
import { TEXT_MODEL } from '../usage/pricing'
import { parseSummaryOutput, type ParsedTask } from './parse-output'
import { buildSummaryPrompt, stripMessageRefs, substituteMemberRefs } from './prompt'
import { buildSummaryReply, type ReplyCandidate } from './reply'

export type SummaryJob = { groupId: string; lineGroupId: string; replyToken: string | null; requesterLineUserId: string | null }

export const SUMMARY_MESSAGE_LIMIT = 100
const SUMMARY_MAX_TOKENS = 4000
const TITLE_MAX = 200
const DETAILS_MAX = 2000

const REPLY_FEATURE_OFF = 'ฟีเจอร์สรุปแชทปิดอยู่ในกลุ่มนี้ เปิดได้ที่การตั้งค่า'
const REPLY_NO_OWNER = 'กลุ่มนี้ยังไม่มีเจ้าของกลุ่มที่ยืนยันแล้ว จึงยังสรุปแชทไม่ได้ กรุณาตั้งค่ากลุ่มให้เสร็จก่อน'
const REPLY_NO_MESSAGES = 'ยังไม่มีข้อความให้สรุป'
const REPLY_FAILED = 'ขอโทษนะ ตอนนี้สรุปแชทไม่สำเร็จ ลองใหม่อีกครั้ง'

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
    logError('summary_failed', { groupId }, err)
    if (!sent.value) await replyText(deps, replyToken, groupId, REPLY_FAILED, sent)
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
  if (!group.ownerConfirmedAt || !group.nominatedOwnerLineUserId) {
    return replyText(deps, replyToken, groupId, REPLY_NO_OWNER, sent)
  }
  const ownerLineUserId = group.nominatedOwnerLineUserId

  // Fair-use cap: a capped Owner gets the cap message only (no AI call, no usage, no Summary).
  // This read is not race-safe by itself; the usage claim in runMeteredAi is the real gate.
  const before = await getFairUseStatus(store, ownerLineUserId, deps.now())
  if (before.level === 'capped') return reply(deps, replyToken, groupId, [capMessage(before)], sent)

  // The command message itself is already stored and takes one slot (M1).
  const messages = (await store.listRecentTextMessages(groupId, SUMMARY_MESSAGE_LIMIT + 1))
    .filter((m) => parseGroupCommand(m.text) === null)
    .slice(-SUMMARY_MESSAGE_LIMIT)
  if (messages.length === 0) return replyText(deps, replyToken, groupId, REPLY_NO_MESSAGES, sent)

  const members = await store.listLiveMembers(groupId)
  const prompt = buildSummaryPrompt({ now: deps.now(), workDescription: group.workDescription, members, messages })

  let parsed: { summary: string; tasks: ParsedTask[] }
  try {
    const result = await runMeteredAi(
      deps,
      { ownerLineUserId, projectId: group.projectId, groupId, purpose: 'summary' },
      { model: TEXT_MODEL, system: prompt.system, user: prompt.user, maxTokens: SUMMARY_MAX_TOKENS },
    )
    parsed = parseSummaryOutput(result.content)
  } catch (err) {
    // The pre-check passed but another request for this Owner claimed the rest of the cap
    // first: same cap reply, no AI call was made, no Summary.
    if (err instanceof FairUseCapReachedError) {
      return reply(deps, replyToken, groupId, [capMessage(await getFairUseStatus(store, ownerLineUserId, deps.now()))], sent)
    }
    // Any error: AdapterError, a raw TimeoutError/SyntaxError from the client, or ModelOutputError.
    logError('summary_ai_failed', { groupId }, err)
    return replyText(deps, replyToken, groupId, REPLY_FAILED, sent)
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
  // The model may still leak a message ref (s14) into text people read: strip it.
  const readable = (text: string) => stripMessageRefs(substituteMemberRefs(text, nameByRef))
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
