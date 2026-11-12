import type { LlmRequest } from '@/server/ports'

// What a fake model "reads" from a Summary request. Tests build model answers from
// these facts instead of asserting on prompt wording, so a layout change touches only
// this file. People appear as member refs (m1, m2...) on member lines; chat lines
// start with a message ref (#1, #2...).

export type ChatLine = { ref: string; time: string | null; senderRef: string | null; text: string }

function memberLines(req: LlmRequest): { ref: string; line: string }[] {
  return req.user.split('\n').flatMap((line) => {
    const m = /^(m\d+)\b/.exec(line)
    return m ? [{ ref: m[1], line }] : []
  })
}

/** The ref of the first member line that carries this text (a LINE name or a
 *  nickname), or null when the request has no such member. */
export function refMentioning(req: LlmRequest, needle: string): string | null {
  return memberLines(req).find((m) => m.line.includes(needle))?.ref ?? null
}

/** Like refMentioning, but throws when no member line carries the text. */
export function refOf(req: LlmRequest, needle: string): string {
  const ref = refMentioning(req, needle)
  if (ref === null) throw new Error(`no member line with ${needle}`)
  return ref
}

/** The chat lines, oldest first. */
export function chatLines(req: LlmRequest): ChatLine[] {
  return req.user.split('\n').flatMap((line) => {
    const m = /^(#\d+)\b/.exec(line)
    if (!m) return []
    const split = line.indexOf(': ')
    const head = split === -1 ? line : line.slice(0, split)
    return [{
      ref: m[1],
      time: /\b\d{2}:\d{2}\b/.exec(head)?.[0] ?? null,
      senderRef: /\b(m\d+)\b/.exec(head)?.[1] ?? null,
      text: split === -1 ? '' : line.slice(split + 2),
    }]
  })
}

/** Member refs the sender tagged in this chat text ("@{m2}"). */
export function taggedRefs(text: string): string[] {
  return [...text.matchAll(/@\{(m\d+)\}/g)].map((m) => m[1])
}

/** The first YYYY-MM-DD in the instructions: the model's idea of today. */
export function todayOf(req: LlmRequest): string | null {
  return /\b\d{4}-\d{2}-\d{2}\b/.exec(req.system)?.[0] ?? null
}
