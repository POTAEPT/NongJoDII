import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LineMessage } from '@/server/line/types'
import type { LlmRequest } from '@/server/ports'
import { TEXT_MODEL } from '@/server/usage/pricing'
import { chatLines, refOf } from '../test/fakes/prompt-reader'
import { ev } from '../test/harness'
import { makeE2eDeps, type E2eDeps } from './deps'
import type { Scenario } from './scenario-types'
import { SignedEventTransport, type Transport } from './transport'

export type ScenarioResult = {
  groupId: string
  storedMessages: number
  summaries: { id: string; summaryText: string; requestedByLineUserId: string | null; firstMessageAt: Date | null; lastMessageAt: Date | null }[]
  candidates: {
    summaryId: string; title: string; details: string | null; assigneeLineUserId: string | null
    dueAt: Date | null; state: string
    /** Not stored: task_candidates has no source column. Always null. */
    source: null
  }[]
  /** One entry per line.reply call on the summary command's reply token. */
  commandReplies: LineMessage[][]
  pushes: number
  /** Model calls made (fake mode); null in real mode. */
  llmRequests: number | null
  replyHasReviewButton: boolean
  /** Problems building the fake model answer from the prompt (should be empty). */
  builderErrors: string[]
}

const FAKE_USAGE = { inputTokens: 1200, outputTokens: 300, costUsd: null }

/** Runs one scenario end to end: cleanup, seed, replay the chat, send the Summary command,
 *  then read back what the database and LINE saw. */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const startMs = Date.parse(scenario.startAt)
  const e2e = makeE2eDeps({ now: new Date(startMs) })
  const transport: Transport = new SignedEventTransport(e2e.deps, e2e.defer)
  const lineGroupId = scenario.group.lineGroupId
  const personaIds = Object.values(scenario.personas).map((p) => p.lineUserId)

  await cleanup(e2e.db, lineGroupId, personaIds)
  const groupId = await seed(e2e, scenario)

  const runId = randomUUID().slice(0, 8)
  const userIdOf = (persona: string): string => {
    const p = scenario.personas[persona]
    if (!p) throw new Error(`scenario ${scenario.name}: unknown persona "${persona}"`)
    return p.lineUserId
  }
  /** Sends one group text at startAt + minute and runs the jobs it queued. */
  const say = async (persona: string, minute: number, text: string, tag: string, replyToken: string): Promise<void> => {
    const at = new Date(startMs + minute * 60_000)
    e2e.setNow(at)
    const res = await transport.send([ev.groupText({
      text, groupId: lineGroupId, userId: userIdOf(persona), timestamp: at.getTime(),
      messageId: `${tag}-msg`, eventId: `${tag}-ev`, replyToken,
    })])
    if (res.status !== 200) throw new Error(`scenario ${scenario.name}: webhook answered ${res.status} for ${tag}`)
    await e2e.runDeferred()
  }

  for (const m of scenario.messages) {
    const tag = `${runId}-${m.id}`
    await say(m.persona, m.minute, m.text, tag, `rt-${tag}`)
  }

  const builderErrors: string[] = []
  const cmd = scenario.summaryCommand
  const cmdTag = `${runId}-summary`
  const cmdReplyToken = `rt-${cmdTag}`
  if (e2e.fakeLlm) {
    e2e.fakeLlm.respond((req) => {
      try {
        return { content: JSON.stringify(buildFakeAnswer(scenario, req)), model: TEXT_MODEL, usage: FAKE_USAGE }
      } catch (err) {
        builderErrors.push(err instanceof Error ? err.message : String(err))
        throw err
      }
    })
  }
  await say(cmd.persona, cmd.minute, cmd.text, cmdTag, cmdReplyToken)

  return collect(e2e, groupId, cmdReplyToken, builderErrors)
}

/** Deletes what an earlier run of this scenario left behind: rows tied to its LINE group and
 *  to the persona IDs (all test IDs start with Ce2e / Ue2e). Child rows go first, parents last:
 *  - ai_usage (owner FK to line_users; group FK is set null on purge, so delete by owner too)
 *  - push_log (no FK; keyed by LINE group ID)
 *  - groups: cascades to messages, summaries, task_candidates, tasks, group_members, files,
 *    task_prompts, fair_use_notices, image_set_cards, weekly_insights
 *  - webhook_events (no FK to groups; messages referenced it, and they are gone now)
 *  - projects (groups.project_id is ON DELETE RESTRICT, so after groups; drive_connections cascade)
 *  - line_users (every referencing row is gone by now) */
async function cleanup(db: SupabaseClient, lineGroupId: string, personaIds: string[]): Promise<void> {
  const check = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`e2e cleanup ${what}: ${error.message}`)
  }
  // Every group that belongs to these test people: this LINE group, groups of a Project they
  // own, and groups they were nominated for (a detached Sub group keeps no Project).
  const { data: projects, error: pErr } = await db.from('projects').select('id').in('owner_line_user_id', personaIds)
  check('projects', pErr)
  const projectIds = ((projects ?? []) as { id: string }[]).map((r) => r.id)
  const groupSets = await Promise.all([
    db.from('groups').select('id, line_group_id').eq('line_group_id', lineGroupId),
    projectIds.length > 0
      ? db.from('groups').select('id, line_group_id').in('project_id', projectIds)
      : Promise.resolve({ data: [], error: null }),
    db.from('groups').select('id, line_group_id').in('nominated_owner_line_user_id', personaIds),
  ])
  const groups = new Map<string, string>()
  for (const { data, error } of groupSets) {
    check('groups', error)
    for (const r of (data ?? []) as { id: string; line_group_id: string }[]) groups.set(r.id, r.line_group_id)
  }
  const groupIds = [...groups.keys()]
  const lineGroupIds = [...new Set([lineGroupId, ...groups.values()])]

  const usage = await db.from('ai_usage').delete().in('owner_line_user_id', personaIds)
  check('ai_usage', usage.error)
  const pushes = await db.from('push_log').delete().in('line_target_id', lineGroupIds)
  check('push_log', pushes.error)
  if (groupIds.length > 0) {
    const del = await db.from('groups').delete().in('id', groupIds)
    check('groups', del.error)
  }
  const events = await db.from('webhook_events').delete().in('line_group_id', lineGroupIds)
  check('webhook_events', events.error)
  const proj = await db.from('projects').delete().in('owner_line_user_id', personaIds)
  check('projects', proj.error)
  const users = await db.from('line_users').delete().in('line_user_id', personaIds)
  check('line_users', users.error)
}

/** Seeds, in dependency order: line_users, the Project (owner = the persona marked owner),
 *  the main group with its confirmed Owner in one insert, then group_members. Also sets the
 *  FakeLine data the handlers read. Returns the group's row ID. */
async function seed(e2e: E2eDeps, scenario: Scenario): Promise<string> {
  const { db, line } = e2e
  const { lineGroupId, name, workDescription } = scenario.group
  const people = Object.values(scenario.personas)
  const owner = Object.values(scenario.personas).find((p) => p.owner === true)
  if (!owner) throw new Error(`scenario ${scenario.name}: no persona is marked owner`)
  const startIso = new Date(Date.parse(scenario.startAt)).toISOString()

  const users = await db.from('line_users').upsert(
    people.map((p) => ({ line_user_id: p.lineUserId, display_name: p.lineName })),
    { onConflict: 'line_user_id' },
  )
  if (users.error) throw new Error(`e2e seed line_users: ${users.error.message}`)

  const project = await db.from('projects').insert({ owner_line_user_id: owner.lineUserId }).select('id').single()
  if (project.error) throw new Error(`e2e seed projects: ${project.error.message}`)
  const projectId = (project.data as { id: string }).id

  // Confirmed Owner: the nominee and the confirmation come in the same write, and the group
  // is the Project's main group (groups_main_needs_project, check_same_owner at COMMIT).
  const group = await db.from('groups').insert({
    line_group_id: lineGroupId, name, project_id: projectId, is_main: true,
    nominated_owner_line_user_id: owner.lineUserId, owner_nominated_by_line_user_id: owner.lineUserId,
    owner_nominated_at: startIso, owner_confirmed_at: startIso, work_description: workDescription,
  }).select('id').single()
  if (group.error) throw new Error(`e2e seed groups: ${group.error.message}`)
  const groupId = (group.data as { id: string }).id

  const members = await db.from('group_members').insert(
    people.map((p) => ({ group_id: groupId, line_user_id: p.lineUserId, source: 'setup_form', role: p.role })),
  )
  if (members.error) throw new Error(`e2e seed group_members: ${members.error.message}`)

  for (const p of people) line.profiles.set(`${lineGroupId}:${p.lineUserId}`, p.lineName)
  line.groupNames.set(lineGroupId, name)
  line.groupMemberCounts.set(lineGroupId, people.length)
  return groupId
}

/** The model answer a real model would give for this prompt: persona keys become member refs
 *  (found by LINE name in the Members lines), scenario message ids become message refs (found
 *  by their text in the chat lines). Throws when the prompt does not show a person or message. */
export function buildFakeAnswer(scenario: Scenario, req: LlmRequest): { summary: string; tasks: unknown[] } {
  const memberRef = (persona: string): string => {
    const p = scenario.personas[persona]
    if (!p) throw new Error(`scenario ${scenario.name}: unknown persona "${persona}"`)
    return refOf(req, `LINE name "${p.lineName}"`)
  }
  const messageRef = (id: string): string => {
    const m = scenario.messages.find((x) => x.id === id)
    if (!m) throw new Error(`scenario ${scenario.name}: unknown message "${id}"`)
    const hit = chatLines(req).find((c) => c.text === m.text)
    if (!hit) throw new Error(`scenario ${scenario.name}: message "${id}" is not in the prompt`)
    return hit.ref
  }
  const fill = (text: string): string => text.replace(/\{([a-z]+)\}/g, (_, persona: string) => `{${memberRef(persona)}}`)
  const answer = scenario.fakeModelAnswer
  return {
    summary: fill(answer.summary),
    tasks: answer.tasks.map((t) => ({
      title: fill(t.title),
      details: t.details === undefined ? null : fill(t.details),
      assignee: t.assignee === null ? null : memberRef(t.assignee),
      due: t.due,
      source: t.source === null ? null : messageRef(t.source),
    })),
  }
}

async function collect(
  e2e: E2eDeps, groupId: string, cmdReplyToken: string, builderErrors: string[],
): Promise<ScenarioResult> {
  const { db, line } = e2e
  const messages = await db.from('messages').select('id', { count: 'exact', head: true }).eq('group_id', groupId)
  if (messages.error) throw new Error(`e2e read messages: ${messages.error.message}`)

  const summaryRows = await db
    .from('summaries')
    .select('id, summary_text, requested_by_line_user_id, first_message_at, last_message_at')
    .eq('group_id', groupId)
    .order('created_at', { ascending: true })
  if (summaryRows.error) throw new Error(`e2e read summaries: ${summaryRows.error.message}`)
  type SummaryDb = {
    id: string; summary_text: string; requested_by_line_user_id: string | null
    first_message_at: string | null; last_message_at: string | null
  }
  const summaries = ((summaryRows.data ?? []) as SummaryDb[]).map((s) => ({
    id: s.id,
    summaryText: s.summary_text,
    requestedByLineUserId: s.requested_by_line_user_id,
    firstMessageAt: s.first_message_at === null ? null : new Date(s.first_message_at),
    lastMessageAt: s.last_message_at === null ? null : new Date(s.last_message_at),
  }))

  let candidates: ScenarioResult['candidates'] = []
  if (summaries.length > 0) {
    const rows = await db
      .from('task_candidates')
      .select('summary_id, title, details, suggested_assignee_line_user_id, suggested_due_at, state')
      .in('summary_id', summaries.map((s) => s.id))
      .order('created_at', { ascending: true })
    if (rows.error) throw new Error(`e2e read task_candidates: ${rows.error.message}`)
    type CandidateDb = {
      summary_id: string; title: string; details: string | null
      suggested_assignee_line_user_id: string | null; suggested_due_at: string | null; state: string
    }
    candidates = ((rows.data ?? []) as CandidateDb[]).map((c) => ({
      summaryId: c.summary_id,
      title: c.title,
      details: c.details,
      assigneeLineUserId: c.suggested_assignee_line_user_id,
      dueAt: c.suggested_due_at === null ? null : new Date(c.suggested_due_at),
      state: c.state,
      source: null,
    }))
  }

  const commandReplies = line.replies
    .filter((r) => r.replyToken === cmdReplyToken)
    .map((r) => r.messages)
  const replyHasReviewButton = commandReplies.some((messages) => hasReviewUri(messages))

  return {
    groupId,
    storedMessages: messages.count ?? 0,
    summaries,
    candidates,
    commandReplies,
    pushes: line.pushes.length,
    llmRequests: e2e.fakeLlm ? e2e.fakeLlm.requests.length : null,
    replyHasReviewButton,
    builderErrors,
  }
}

/** True when some object in the value has a uri that opens the Summary review page. */
function hasReviewUri(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReviewUri)
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  if (typeof o.uri === 'string' && o.uri.includes('view=review')) return true
  return Object.values(o).some(hasReviewUri)
}
