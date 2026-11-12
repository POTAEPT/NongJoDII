import type { Member, MessageMention, StoredMessage } from '../ports'
import { bangkokTodayLabel, formatPromptTime } from '../time/bangkok'

export type PromptRef = { ref: string; lineUserId: string }          // 'm1', 'm2', ...
export type MessageRef = { ref: string; message: StoredMessage }     // '#1', '#2', ...

const MESSAGE_TEXT_MAX = 500

/** Builds the Summary prompt. People appear only as member refs (mN); nicknames
 *  appear only here, never on a screen (rule 9). */
export function buildSummaryPrompt(p: {
  now: Date; workDescription: string | null; members: Member[]; messages: StoredMessage[]
}): { system: string; user: string; memberRefs: PromptRef[]; messageRefs: MessageRef[] } {
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
  for (const msg of p.messages) {
    if (msg.senderLineUserId === null || refByUser.has(msg.senderLineUserId)) continue
    const ref = addRef(msg.senderLineUserId)
    lines.push(memberLine(ref, msg.senderDisplayName, [], null))
  }

  const messageRefs: MessageRef[] = p.messages.map((message, i) => ({ ref: `#${i + 1}`, message }))
  const chat = messageRefs.map(({ ref, message }) => {
    const sender = message.senderLineUserId === null ? '?' : refByUser.get(message.senderLineUserId)
    // Tags first: their offsets point into the raw stored text.
    const text = withMentionRefs(message.text, message.mentions, liveRefByUser)
      .replace(/\r\n|\r|\n/g, ' ')
      .slice(0, MESSAGE_TEXT_MAX)
    return `${ref} [${formatPromptTime(message.sentAt)}] ${sender}: ${text}`
  })

  const user = [
    `Group context: ${p.workDescription ?? '-'}`,
    'Members:',
    ...lines,
    'Chat (oldest first, Asia/Bangkok time):',
    ...chat,
  ].join('\n')

  const system = [
    'You are NongJoDII (น้องจดดี), an assistant in a Thai student team\'s LINE group.',
    'Read the chat and reply with ONLY a JSON object of this shape:',
    '{"summary": string, "tasks": [{"title": string, "details": string|null, "assignee": string|null, "due": string|null, "source": string|null}]}',
    'Rules:',
    '- Write summary, title and details in Thai. summary: at most 800 characters.',
    '- A task is concrete work that someone should still do according to the chat. Skip work the chat marks as finished. At most 10 tasks. Never invent tasks.',
    '- In summary, title and details, refer to a person ONLY by their member ref in braces, such as {m2}. Never write a person\'s name or nickname in those fields.',
    '- In the chat, @{m2} means the sender tagged that member; trust a tag over a name, since two members can share a LINE name.',
    '- assignee: the member ref (such as "m2") of the person who should do it. Match people by tag, LINE name or nickname. null when unclear.',
    `- due: ISO 8601 date-time with +07:00 offset when the chat states a deadline, else null. Today is ${bangkokTodayLabel(p.now)} (Asia/Bangkok).`,
    '- source: the message ref (such as "#14") where the task was asked for or agreed.',
  ].join('\n')

  return { system, user, memberRefs, messageRefs }
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
