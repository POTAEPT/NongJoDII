import type { Member, MessageMention, StoredMessage, TaskStatus } from '../ports'
import { bangkokTodayLabel, formatPromptTime } from '../time/bangkok'
import { TASK_COUNT_HINTS, type TaskCountHint } from './check'

export type PromptRef = { ref: string; lineUserId: string }          // 'm1', 'm2', ...
export type MessageRef = { ref: string; message: StoredMessage }     // 'msg1', 'msg2', ...

const MESSAGE_TEXT_MAX = 500

/** #108: a Task the group already has, which the Summary must not propose again. */
export type ExistingTask = { title: string; status: TaskStatus; tags?: string[] }

const STATUS_WORD: Record<TaskStatus, string> = { not_assigned: 'no assignee', in_process: 'in progress', done: 'done' }

/** Builds the Summary prompt. People appear only as member refs (mN); nicknames
 *  appear only here, never on a screen (rule 9).
 *  #108: `messages` is the chat since the group's last Summary, the only source of tasks.
 *  `context` is chat an earlier Summary already covered, given for understanding only and
 *  without message refs (so no task can point at it). `existingTasks` are the group's open
 *  and recently done Tasks, which the model must not propose again.
 *  #157: `summaryOnly` (the decision model found no work) asks for the summary alone, with no
 *  Task part; `taskHint` adds "expect about N separate tasks"; `alreadyFound` (given only on the
 *  retry, possibly empty) lists the first answer's task titles and asks only for the missed tasks. With none of the
 *  three the prompt is the one used before #157. */
export function buildSummaryPrompt(p: {
  now: Date; workDescription: string | null; members: Member[]; messages: StoredMessage[]
  context?: StoredMessage[]; existingTasks?: ExistingTask[]
  /** #110: the group's starting tags, set by the Owner; the model picks from these first. */
  groupTags?: string[]
  summaryOnly?: boolean; taskHint?: TaskCountHint | null; alreadyFound?: string[]
}): { system: string; user: string; memberRefs: PromptRef[]; messageRefs: MessageRef[] } {
  const context = p.context ?? []
  const summaryOnly = p.summaryOnly === true
  // Summary only: no Task part at all, so the existing Tasks and the tags stay out too.
  const existingTasks = summaryOnly ? [] : p.existingTasks ?? []
  const groupTags = summaryOnly ? [] : p.groupTags ?? []
  // The retry: `alreadyFound` is given (it may be empty when the first answer found none).
  const retry = !summaryOnly && p.alreadyFound !== undefined
  const alreadyFound = retry ? p.alreadyFound ?? [] : []
  const memberRefs: PromptRef[] = []
  const refByUser = new Map<string, string>()
  const lines: string[] = []
  // Only live Members can be tagged as a ref: a tag of anyone else stays plain text.
  const liveRefByUser = new Map<string, string>()
  const addRef = (lineUserId: string): string => {
    const ref = `m${memberRefs.length + 1}`
    memberRefs.push({ ref, lineUserId })
    refByUser.set(lineUserId, ref)
    return ref
  }

  for (const m of p.members) {
    if (refByUser.has(m.lineUserId)) continue
    const ref = addRef(m.lineUserId)
    liveRefByUser.set(m.lineUserId, ref)
    lines.push(memberLine(ref, m.displayName, m.nicknames, m.role))
  }
  // Senders who are not live Members (left or unknown) still get a ref.
  for (const msg of [...context, ...p.messages]) {
    if (msg.senderLineUserId === null || refByUser.has(msg.senderLineUserId)) continue
    const ref = addRef(msg.senderLineUserId)
    lines.push(memberLine(ref, msg.senderDisplayName, [], null))
  }

  const line = (message: StoredMessage): string => {
    const sender = message.senderLineUserId === null ? '?' : refByUser.get(message.senderLineUserId)
    // Tags first: their offsets point into the raw stored text.
    const text = withMentionRefs(message.text, message.mentions, liveRefByUser)
      .replace(/\r\n|\r|\n/g, ' ')
      .slice(0, MESSAGE_TEXT_MAX)
    return `[${formatPromptTime(message.sentAt)}] ${sender}: ${text}`
  }
  const messageRefs: MessageRef[] = p.messages.map((message, i) => ({ ref: `msg${i + 1}`, message }))
  const chat = messageRefs.map(({ ref, message }) => `${ref} ${line(message)}`)

  const user = [
    `Group context: ${p.workDescription ?? '-'}`,
    'Members:',
    ...lines,
    ...(existingTasks.length > 0
      ? ['Existing tasks (already in the group; never propose these again):',
        ...existingTasks.map((t) => `- [${STATUS_WORD[t.status]}] ${oneLine(t.title)}`)]
      : []),
    ...(retry
      ? ['Tasks already found (an earlier answer listed these; never repeat them):',
        ...(alreadyFound.length > 0 ? alreadyFound.map((t) => `- ${oneLine(t)}`) : ['- (none)'])]
      : []),
    ...(groupTags.length > 0 ? [`Group tags (set by the Owner; use these first): ${groupTags.join(', ')}`] : []),
    ...(tagsInUse(existingTasks).length > 0 ? [`Tags in use: ${tagsInUse(existingTasks).join(', ')}`] : []),
    ...(context.length > 0
      ? ['Earlier chat (already summarized before; context only, oldest first):', ...context.map(line)]
      : []),
    'Chat (oldest first, Asia/Bangkok time):',
    ...chat,
  ].join('\n')

  if (summaryOnly) return { system: summaryOnlySystem(), user, memberRefs, messageRefs }

  const hint = p.taskHint ? TASK_COUNT_HINTS[p.taskHint] : null
  const system = [
    'You are NongJoDII (น้องจดดี), an assistant in a Thai student team\'s LINE group.',
    'Read the chat and reply with ONLY a JSON object of this shape:',
    '{"summary": string, "tasks": [{"title": string, "details": string|null, "assignee": string|null, "due": string|null, "source": string|null, "tags": string[]}]}',
    'Rules:',
    '- Write summary, title and details in Thai. summary: at most 800 characters.',
    '- A task is concrete work that someone should still do according to the chat. Skip work the chat marks as finished. At most 10 tasks. Never invent tasks.',
    ...(hint
      ? [`- Expect about ${hint.expect} separate tasks in the "Chat" section. Work for different people, or with different deadlines, is a separate task each. Never invent a task to reach that number.`]
      : []),
    ...(retry
      ? ['- An earlier answer missed some tasks. List ONLY the tasks that are not under "Tasks already found"; never repeat a found one. [] when there are no others.']
      : []),
    '- Summarize and take tasks ONLY from the "Chat" section. "Earlier chat" was summarized before: use it only to understand the new chat, and never take a task from it.',
    '- Never propose a task that is already in "Existing tasks", whatever its status and even if the chat words it differently.',
    '- In summary, title and details, refer to a person ONLY by their member ref in braces, such as {m2}. Never write a person\'s name or nickname in those fields.',
    '- Never write a message ref (such as msg14) in summary, title or details; readers never see message refs. Use message refs only in source.',
    '- In the chat, @{m2} means the sender tagged that member; trust a tag over a name, since two members can share a LINE name.',
    '- assignee: the member ref (such as "m2") of the person who should do it. Match people by tag, LINE name or nickname. null when unclear.',
    `- due: ISO 8601 date-time with +07:00 offset when the chat states a deadline, else null. Today is ${bangkokTodayLabel(p.now)} (Asia/Bangkok).`,
    '- source: the message ref (such as "msg14") where the task was asked for or agreed.',
    '- tags: 0 to 3 short labels (at most 20 characters each) for the kind of work, such as "ออกแบบ" or "เอกสาร". Pick from "Group tags" first, then reuse "Tags in use"; a new tag only when none fits. Never a person\'s name or nickname. [] when none fits.',
  ].join('\n')

  return { system, user, memberRefs, messageRefs }
}

/** #157: the system text when the decision model found no work in the chat: the summary only. */
function summaryOnlySystem(): string {
  return [
    'You are NongJoDII (น้องจดดี), an assistant in a Thai student team\'s LINE group.',
    'Read the chat and reply with ONLY a JSON object of this shape:',
    '{"summary": string}',
    'Rules:',
    '- Write summary in Thai, at most 800 characters.',
    '- Summarize ONLY the "Chat" section. "Earlier chat" was summarized before: use it only to understand the new chat.',
    '- In summary, refer to a person ONLY by their member ref in braces, such as {m2}. Never write a person\'s name or nickname.',
    '- Never write a message ref (such as msg14) in summary; readers never see message refs.',
    '- In the chat, @{m2} means the sender tagged that member; trust a tag over a name, since two members can share a LINE name.',
  ].join('\n')
}

function oneLine(title: string): string {
  return title.replace(/\r\n|\r|\n/g, ' ').slice(0, 200)
}

/** Replaces each LINE user tag of a live Member ("@Pim Sirin") with "@{mN}", so who
 *  was tagged never depends on display names, which Members can share. A tag with no
 *  userId, of someone who is not a live Member, of the whole group ('all'), or whose
 *  span is out of bounds, overlaps another, or does not start at "@" (a sign the
 *  offsets do not match this text) is left as written. */
export function withMentionRefs(
  text: string, mentions: MessageMention[] | null, refByUser: Map<string, string>,
): string {
  if (!mentions || mentions.length === 0) return text
  const spans = mentions
    .filter((m) => Number.isInteger(m.index) && Number.isInteger(m.length) && m.index >= 0 && m.length > 0)
    .filter((m) => m.index + m.length <= text.length && text[m.index] === '@')
    .sort((a, b) => a.index - b.index)
  let out = ''
  let pos = 0
  for (const m of spans) {
    if (m.index < pos) continue // overlaps the previous span
    const ref = m.type === 'user' && m.userId !== null ? refByUser.get(m.userId) : undefined
    out += text.slice(pos, m.index) + (ref ? `@{${ref}}` : text.slice(m.index, m.index + m.length))
    pos = m.index + m.length
  }
  return out + text.slice(pos)
}

function memberLine(ref: string, displayName: string | null, nicknames: string[], role: string | null): string {
  const nick = nicknames.length > 0 ? nicknames.join(', ') : '-'
  return `${ref}: LINE name "${displayName ?? 'unknown'}"; nicknames: ${nick}; role: ${role ?? '-'}`
}

/** Replaces every {mN} with the LINE name for that ref; a ref with a null name or
 *  an unknown ref becomes 'สมาชิก'. Text outside {mN} is left exactly as is. */
export function substituteMemberRefs(text: string, nameByRef: Map<string, string | null>): string {
  return text.replace(/\{(m\d+)\}/g, (_, ref: string) => nameByRef.get(ref) ?? 'สมาชิก')
}

// A message ref the model wrote into reader-facing text despite the rule, with an
// optional Thai lead-in ("ในข้อความ msg37", "(msg37)", "{msg37}"). The "msg" prefix
// keeps real words such as "s3" safe. The old "#37" form is removed only after such
// a lead-in, so "PR #36" from the chat stays.
const LEAD_IN = String.raw`(?:(?:ใน|จาก|ตาม)?ข้อความ(?:ที่)?[ \t]*)`
const LEAKED_REF = String.raw`[ \t]*(?:${LEAD_IN}?[({]?\bmsg\d+\b[)}]?|${LEAD_IN}#\d+\b)`

/** Removes leaked message refs from text shown to people, then tidies the spaces
 *  left behind. Text without a ref is returned unchanged. */
export function stripMessageRefs(text: string): string {
  if (!new RegExp(LEAKED_REF).test(text)) return text
  return text
    .replace(new RegExp(LEAKED_REF, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.)])/g, '$1')
    .trim()
}

/** #109: the distinct tags on the group's existing Tasks, so the model reuses them. */
function tagsInUse(tasks: ExistingTask[]): string[] {
  const seen = new Map<string, string>()
  for (const t of tasks) for (const tag of t.tags ?? []) {
    const k = tag.toLocaleLowerCase('th')
    if (!seen.has(k)) seen.set(k, tag)
  }
  return [...seen.values()].slice(0, 30)
}
