import type { Member, MessageMention, StoredMessage, TaskStatus } from '../ports'
import { bangkokCalendar, bangkokTodayLabel, formatPromptTime } from '../time/bangkok'

export type PromptRef = { ref: string; lineUserId: string }          // 'm1', 'm2', ...
export type MessageRef = { ref: string; message: StoredMessage }     // 'msg1', 'msg2', ...

const MESSAGE_TEXT_MAX = 500

/** Only project work is a Task: casual chat never becomes one, nor unassigned work in the summary. */
export const PROJECT_WORK_ONLY = 'List as tasks ONLY work toward the group\'s project or study goals. Never a snack, drink or food order (such as ordering milk tea), a joke or a line said for a laugh (such as a line with 555), a social plan, or a member\'s personal errand. Booking a meeting room, printing or sending a file for the project is work. In summary, never call such casual items unassigned or open work.'
/** #157: the count hint and the retry never justify adding casual chat to reach the number. */
export const COUNT_IS_PROJECT_WORK = 'The count is of project work only: never add a snack, drink, food order, joke or personal errand to reach it.'

/** #108: a Task the group already has, which the Summary must not propose again. */
export type ExistingTask = { title: string; status: TaskStatus; tags?: string[] }

const STATUS_WORD: Record<TaskStatus, string> = { not_assigned: 'no assignee', in_process: 'in progress', done: 'done' }

/** Builds the Summary prompt. People appear only as member refs (mN); nicknames
 *  appear only here, never on a screen (rule 9).
 *  #108: `messages` is the chat since the group's last Summary, the only source of tasks.
 *  `context` is chat an earlier Summary already covered, given for understanding only and
 *  without message refs (so no task can point at it). `existingTasks` are the group's open
 *  and recently done Tasks, which the model must not propose again. */
export function buildSummaryPrompt(p: {
  now: Date; workDescription: string | null; members: Member[]; messages: StoredMessage[]
  context?: StoredMessage[]; existingTasks?: ExistingTask[]
  /** #110: the group's starting tags, set by the Owner; the model picks from these first. */
  groupTags?: string[]
  /** #157: what the Jev pre-check found: a count hint, or that the chat holds no work. */
  precheck?: { noTask: true } | { noTask: false; countHint: string } | null
}): { system: string; user: string; chat: string; memberRefs: PromptRef[]; messageRefs: MessageRef[] } {
  const context = p.context ?? []
  const existingTasks = p.existingTasks ?? []
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
    // #161: weekdays, in English and Thai, so "ศุกร์นี้" and "วันพฤหัส" map to a date.
    'Calendar (Asia/Bangkok), one day per line (date, weekday, Thai name, Thai short form, week):',
    ...bangkokCalendar(p.now),
    'Members:',
    ...lines,
    ...(existingTasks.length > 0
      ? ['Existing tasks (already in the group; never propose these again):',
        ...existingTasks.map((t) => `- [${STATUS_WORD[t.status]}] ${t.title.replace(/\r\n|\r|\n/g, ' ').slice(0, 200)}`)]
      : []),
    ...((p.groupTags ?? []).length > 0 ? [`Group tags (set by the Owner; use these first): ${(p.groupTags ?? []).join(', ')}`] : []),
    ...(tagsInUse(existingTasks).length > 0 ? [`Tags in use: ${tagsInUse(existingTasks).join(', ')}`] : []),
    ...(context.length > 0
      ? ['Earlier chat (already summarized before; context only, oldest first):', ...context.map(line)]
      : []),
    'Chat (oldest first, Asia/Bangkok time):',
    ...chat,
    // #157: the Jev pre-check read the same chat first.
    ...(p.precheck?.noTask === true
      ? ['A first reading found no work to do in this chat: return "tasks": [] and write the summary only.']
      : p.precheck && p.precheck.noTask === false
        ? [`A first reading found ${p.precheck.countHint} separate pieces of work in the Chat. List each separate piece of work as its own task. ${COUNT_IS_PROJECT_WORK}`]
        : []),
  ].join('\n')

  const system = [
    'You are NongJoDII (น้องจดดี), an assistant in a Thai student team\'s LINE group.',
    'Read the chat and reply with ONLY a JSON object of this shape:',
    '{"summary": string, "tasks": [{"title": string, "details": string|null, "assignee": string|null, "due": string|null, "source": string|null, "tags": string[]}]}',
    'Rules:',
    '- Write summary, title and details in Thai. summary: at most 800 characters.',
    '- A task is concrete work toward the group\'s project or study goals (see "Group context") that someone should still do according to the chat. Skip work the chat marks as finished. At most 10 tasks. Never invent tasks.',
    // Live run 2026-11-17: "555 เดี๋ยวสั่งชานมด้วย" became a Task and the summary called it unassigned work.
    `- ${PROJECT_WORK_ONLY}`,
    '- Summarize and take tasks ONLY from the "Chat" section. "Earlier chat" was summarized before: use it only to understand the new chat, and never take a task from it.',
    '- Never propose a task that is already in "Existing tasks", whatever its status and even if the chat words it differently.',
    '- In summary, title and details, refer to a person ONLY by their member ref in braces, such as {m2}. Always write the braces: never a bare m2 or ม2. Never write a person\'s name or nickname in those fields.',
    '- Never write a message ref (such as msg14) in summary, title or details; readers never see message refs. Use message refs only in source.',
    '- In the chat, @{m2} means the sender tagged that member; trust a tag over a name, since two members can share a LINE name.',
    '- assignee: the member ref (such as "m2") of the person who will do it. Match people by tag, LINE name or nickname.',
    // #138 (E2E round 1): the model made the person who raised a task its owner.
    '- The assignee is someone who said they will do it ("เดี๋ยวทำ", "เราเอง", "ได้ เดี๋ยวทำให้"), or someone named or tagged for it ("ฝาก {m2} ทำ") who did not refuse.',
    '- The person who asks for the work, reminds others ("อย่าลืม...") or asks "ใครว่าง" / "ใครทำได้" is NOT the assignee for that reason alone. A maybe ("เดี๋ยวดูอีกที", "ไม่แน่ใจ") is not taking it.',
    '- When nobody took the task, assignee is null. Prefer null to a guess.',
    `- due: null when the chat states no deadline. Today is ${bangkokTodayLabel(p.now)} (Asia/Bangkok). A deadline with a day but no time: the date only, "YYYY-MM-DD" (the day ends at 23:59). A deadline with a time: ISO 8601 date-time with +07:00 offset. Never make up a time: 00:00 only when the chat says midnight ("เที่ยงคืน").`,
    '- source: the message ref (such as "msg14") where the task was asked for or agreed.',
    // #161: weekday deadlines came back as the wrong day.
    '- Work out dates from "Calendar" in the user message: find the day there, never count days. A weekday word (Thai or English, with or without "วัน": จันทร์, อังคาร, พุธ, พฤหัส/พฤหัสบดี/พฤ., ศุกร์/ศ., เสาร์, อาทิตย์/อา., Fri) means the NEXT such day on or after today in this list; "ศุกร์นี้" and "วันศุกร์" are that day too. หน้า / next week means the one in the following week: "ศุกร์หน้า" or "ศุกร์สัปดาห์หน้า" is the Friday of the next week (weeks start on Monday). "พรุ่งนี้" is tomorrow; "มะรืน" is the day after tomorrow. A time with no day is today if it is still ahead, else tomorrow. Thai times: "5 โมงเย็น" 17:00, "6 โมงเย็น" 18:00, "เที่ยง" 12:00, "บ่าย 2" 14:00, "2 ทุ่ม" 20:00. A deadline is never before today.',
    '- tags: 0 to 3 short labels (at most 20 characters each) for the kind of work, such as "ออกแบบ" or "เอกสาร". Pick from "Group tags" first, then reuse "Tags in use"; a new tag only when none fits. Never a person\'s name or nickname. [] when none fits.',
  ].join('\n')

  return { system, user, chat: chat.join('\n'), memberRefs, messageRefs }
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

// A member ref, braced as the prompt asks ("{m2}", also "{ม2}"), or written bare despite it
// (live 2026-11-17: "m1", "ม1"): "ม.2", "[m2]", "(m2)" and a range "m1-m3". One pattern, one
// pass, so a LINE name put in for a ref is never read as a ref again.
const ONE_REF = String.raw`(?:m|ม\.?)(\d+)`
const MEMBER_REF = new RegExp(
  String.raw`\{(?:m|ม)(\d+)\}|(\[)?(?<![A-Za-z0-9])${ONE_REF}(?:[ \t]*[-–][ \t]*${ONE_REF})?(?!\d)(\])?`, 'g',
)
const RANGE_MAX = 20

/** Replaces every member ref with the LINE name for that ref; a null name becomes 'สมาชิก'.
 *  A braced ref that is not in this prompt also becomes 'สมาชิก'. A bare ref ("m1", "ม1",
 *  "ม.1", "[m1]" without its brackets, "(m1)" keeping them) is swapped only when its number
 *  is a ref in this prompt, so other words and numbers stay; a range "m1-m3" of known refs
 *  lists each name. Other text is left exactly as is. */
export function substituteMemberRefs(text: string, nameByRef: Map<string, string | null>): string {
  const name = (n: string) => nameByRef.get(`m${n}`) ?? 'สมาชิก'
  const known = (n: string) => nameByRef.has(`m${n}`)
  return text.replace(MEMBER_REF, (whole: string, braced?: string, open?: string, a?: string, b?: string, close?: string) => {
    if (braced !== undefined) return name(braced)
    if (a === undefined) return whole
    const lo = Number(a)
    const hi = b === undefined ? lo : Number(b)
    let out: string
    if (b !== undefined && lo < hi && hi - lo <= RANGE_MAX
      && Array.from({ length: hi - lo + 1 }, (_, i) => String(lo + i)).every(known)) {
      out = Array.from({ length: hi - lo + 1 }, (_, i) => name(String(lo + i))).join(', ')
    } else {
      const inner = whole.slice(open ? 1 : 0, close ? -1 : undefined)
      const swapped = inner.replace(new RegExp(ONE_REF, 'g'), (t: string, n: string) => (known(n) ? name(n) : t))
      if (swapped === inner) return whole
      out = swapped
    }
    return open && close ? out : `${open ?? ''}${out}${close ?? ''}`
  })
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
