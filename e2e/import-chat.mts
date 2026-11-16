// #118 part 1: a LINE chat export (.txt) becomes an e2e scenario (e2e/scenario-types.ts).
//
//   npm run import-chat -- <chat.txt> [options]
//
//   --out <dir>        where to write (default e2e/private, which git ignores)
//   --name <name>      scenario name (default from the file name)
//   --from YYYY-MM-DD  keep messages from this Bangkok day
//   --to YYYY-MM-DD    keep messages up to this Bangkok day (inclusive)
//   --owner <persona>  the persona who sends the Summary command (default: the most active)
//   --rename a=b,c=d   more words to replace in the text (nicknames the sender names miss)
//   --keep-links       keep URLs (default: each URL becomes [ลิงก์])
//   --work <text>      the group's work description
//   --pitch            a stage script: one line per minute from --start, at most --max-lines
//   --start <iso>      with --pitch, the time of the first line (default: now)
//   --max-lines <n>    with --pitch, how many lines to keep (default 10)
//
// Writes <name>.json (personas only, safe to read) and <name>.names.json (real name ->
// persona; never commit it). Real names are replaced in sender fields and in @mentions;
// nicknames inside the text are not known to the tool, so pass them with --rename and read
// the output before sharing it.
//
// Runs on Node 24's own TypeScript support (.mts: an ES module), so this file imports types only.

import type { Scenario, ScenarioPersona } from './scenario-types'

/** The export's placeholders for what a text export cannot hold, by kind. */
const PLACEHOLDERS: Record<string, string> = {
  '[สติกเกอร์]': 'sticker', '[Sticker]': 'sticker',
  '[รูป]': 'photo', '[รูปภาพ]': 'photo', '[Photo]': 'photo', '[Photos]': 'photo', '[อัลบั้ม]': 'photo', '[Album]': 'photo',
  '[วิดีโอ]': 'video', '[Video]': 'video',
  '[ไฟล์]': 'file', '[File]': 'file',
  '[ข้อความเสียง]': 'voice', '[ไฟล์เสียง]': 'voice', '[Voice message]': 'voice', '[Audio]': 'voice',
  '[ตำแหน่งที่ตั้ง]': 'location', '[Location]': 'location',
  '[ผู้ติดต่อ]': 'contact', '[Contact]': 'contact',
}

const THAI_DAY = '(?:อา|จ|อ|พ|พฤ|ศ|ส)\\.?'
const EN_DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*'
/** "ศ. 24/4/2026" (the Thai app), "Fri, 24/04/2026", "2026/04/24(Fri)", "2026.04.24 Friday". */
const DATE_DMY = new RegExp(`^(?:${THAI_DAY}|${EN_DAY}),?\\s+(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s*$`)
const DATE_YMD = new RegExp(`^(\\d{4})[./-](\\d{1,2})[./-](\\d{1,2})\\s*(?:\\(?(?:${THAI_DAY}|${EN_DAY})\\)?)?\\s*$`)
/** "21:36<TAB>name<TAB>text"; some exports put AM/PM before the time. */
const MESSAGE = /^(?:(AM|PM|ก่อนเที่ยง|หลังเที่ยง)\s*)?(\d{1,2}):(\d{2})\t([^\t]*)\t([\s\S]*)$/
/** "21:36<TAB>text": a system line (joined, left, unsent, renamed): no sender. */
const SYSTEM = /^(?:(?:AM|PM|ก่อนเที่ยง|หลังเที่ยง)\s*)?\d{1,2}:\d{2}\t[^\t]*$/
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000

export type ExportMessage = { at: Date; sender: string; text: string; line: number }

export type ParsedExport = {
  groupName: string | null
  messages: ExportMessage[]
  /** Placeholders dropped, by kind (sticker, photo, ...). */
  skipped: Record<string, number>
  systemLines: number
  /** Lines the parser could not place (line number, first characters). */
  problems: { line: number; text: string }[]
}

function bangkokInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - BKK_OFFSET_MS)
}

/** A Buddhist-era year (2569) read as the Gregorian one (2026). */
function gregorian(y: number): number {
  return y > 2400 ? y - 543 : y
}

function parseDateLine(line: string): { y: number; m: number; d: number } | null {
  let m = DATE_DMY.exec(line)
  if (m) return { y: gregorian(Number(m[3])), m: Number(m[2]), d: Number(m[1]) }
  m = DATE_YMD.exec(line)
  if (m) return { y: gregorian(Number(m[1])), m: Number(m[2]), d: Number(m[3]) }
  return null
}

/** Reads a LINE chat export. Never throws on content: what it cannot place goes to problems. */
export function parseLineExport(raw: string): ParsedExport {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/)
  const out: ParsedExport = { groupName: null, messages: [], skipped: {}, systemLines: 0, problems: [] }
  let day: { y: number; m: number; d: number } | null = null
  let current: ExportMessage | null = null
  let quoted = false // inside a "..." multi-line message (some app versions quote them)

  const close = () => {
    if (current) {
      if (quoted) current.text = current.text.replace(/^"/, '')
      out.messages.push(current)
    }
    current = null
    quoted = false
  }

  lines.forEach((line, i) => {
    const n = i + 1
    if (quoted && current) {
      if (/"\s*$/.test(line)) {
        current.text += `\n${line.replace(/"\s*$/, '')}`
        current.text = current.text.replace(/^"/, '')
        quoted = false
        out.messages.push(current)
        current = null
      } else {
        current.text += `\n${line}`
      }
      return
    }
    if (i < 3 && /^\[LINE\]/.test(line)) {
      const name = /^\[LINE\]\s*(?:ประวัติการแชทของ|ประวัติการแชทกับ|Chat history (?:in|with))\s*(.+)$/.exec(line)
      out.groupName = name ? name[1].trim() : null
      return
    }
    if (i < 3 && /^(?:บันทึกเมื่อ|Saved on)/.test(line)) return
    if (line.trim() === '') { close(); return }
    const date = parseDateLine(line)
    if (date) { close(); day = date; return }
    const msg = MESSAGE.exec(line)
    if (msg) {
      close()
      if (!day) { out.problems.push({ line: n, text: line.slice(0, 40) }); return }
      let h = Number(msg[2])
      if ((msg[1] === 'PM' || msg[1] === 'หลังเที่ยง') && h < 12) h += 12
      if ((msg[1] === 'AM' || msg[1] === 'ก่อนเที่ยง') && h === 12) h = 0
      const text = msg[5]
      current = { at: bangkokInstant(day.y, day.m, day.d, h, Number(msg[3])), sender: msg[4].trim(), text, line: n }
      if (text.startsWith('"') && !/^".*"\s*$/.test(text)) quoted = true
      else if (/^".*"$/.test(text) && text.length > 1) current.text = text.slice(1, -1)
      return
    }
    if (SYSTEM.test(line)) { close(); out.systemLines++; return }
    // Anything else continues the message above it (an unquoted multi-line message).
    if (current) { (current as ExportMessage).text += `\n${line}`; return }
    out.problems.push({ line: n, text: line.slice(0, 40) })
  })
  close()

  // Drop placeholders and messages that held only emoji markers.
  out.messages = out.messages.filter((m) => {
    const t = m.text.trim()
    const kind = PLACEHOLDERS[t]
    if (kind) { out.skipped[kind] = (out.skipped[kind] ?? 0) + 1; return false }
    if (t.replace(/\(emoji\)/g, '').trim() === '') { out.skipped.emoji = (out.skipped.emoji ?? 0) + 1; return false }
    return true
  })
  return out
}

/** Neutral Thai nicknames for personas, in order of how much each person talks. */
export const PERSONA_NAMES = ['พิม', 'แบงค์', 'มายด์', 'ต้น', 'เนย', 'บอส', 'ปอ', 'จูน', 'เอิร์ธ', 'แพร', 'กาย', 'ฝน']

export type ImportOptions = {
  name: string
  from?: string
  to?: string
  owner?: string
  rename?: Record<string, string>
  keepLinks?: boolean
  work?: string
  pitch?: { start: Date; maxLines: number }
}

export type ImportResult = {
  scenario: Scenario
  /** Real sender name -> persona name. Private: never commit. */
  names: Record<string, string>
  warnings: string[]
}

/** A stable 29-hex-digit tail from a string, so the same file maps to the same test IDs. */
function hexTail(s: string, salt: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const src = `${salt}:${s}`
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2).slice(0, 29)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dayOf(d: Date): string {
  const b = new Date(d.getTime() + BKK_OFFSET_MS)
  return b.toISOString().slice(0, 10)
}

/** Turns a parsed export into a scenario with personas in place of real names. */
export function toScenario(parsed: ParsedExport, opts: ImportOptions): ImportResult {
  const warnings: string[] = []
  let msgs = parsed.messages.filter((m) => (!opts.from || dayOf(m.at) >= opts.from) && (!opts.to || dayOf(m.at) <= opts.to))
  if (msgs.length === 0) throw new Error('no messages left after the date filter')
  if (opts.pitch) msgs = msgs.slice(0, opts.pitch.maxLines)

  // Personas: the most active sender first.
  const counts = new Map<string, number>()
  for (const m of msgs) counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1)
  const senders = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
  if (senders.length > PERSONA_NAMES.length) throw new Error(`${senders.length} senders; at most ${PERSONA_NAMES.length} are supported`)
  const names: Record<string, string> = {}
  senders.forEach((s, i) => { names[s] = PERSONA_NAMES[i] })
  const keyOf = (s: string) => `p${senders.indexOf(s) + 1}`

  const ownerKey = opts.owner
    ? Object.keys(names).map(keyOf).find((k) => PERSONA_NAMES[Number(k.slice(1)) - 1] === opts.owner)
    : 'p1'
  if (!ownerKey) throw new Error(`--owner ${opts.owner} is not one of: ${Object.values(names).join(', ')}`)

  const personas: Record<string, ScenarioPersona> = {}
  for (const s of senders) {
    const key = keyOf(s)
    personas[key] = {
      lineName: names[s], role: null, ...(key === ownerKey ? { owner: true } : {}),
      lineUserId: `Ue2e${hexTail(s, opts.name)}`,
    }
  }

  // Replace real names (longest first, so "แม็ก" never cuts into "! Max แม็ก"), then --rename words.
  const replacements: [string, string][] = [
    ...senders.map((s): [string, string] => [s, names[s]]),
    ...Object.entries(opts.rename ?? {}),
  ].filter(([a]) => a.trim() !== '').sort((a, b) => b[0].length - a[0].length)
  const clean = (text: string): string => {
    let t = text
    for (const [real, persona] of replacements) t = t.replace(new RegExp(escapeRegExp(real), 'g'), persona)
    if (!opts.keepLinks) t = t.replace(/https?:\/\/\S+/g, '[ลิงก์]')
    return t.replace(/\(emoji\)/g, '').trim()
  }

  const start = opts.pitch ? opts.pitch.start : msgs[0].at
  const messages = msgs.map((m, i) => ({
    id: `m${i + 1}`,
    persona: keyOf(m.sender),
    minute: opts.pitch ? i : Math.round((m.at.getTime() - start.getTime()) / 60_000),
    text: clean(m.text),
  }))
  const last = messages[messages.length - 1].minute

  // The Summary reads at most this many new messages (src/server/summary/run-summary.ts).
  if (messages.length > 100) {
    warnings.push(`${messages.length} messages: the Summary reads only the last 100. Narrow it with --from and --to.`)
  }
  const spanDays = (msgs[msgs.length - 1].at.getTime() - msgs[0].at.getTime()) / 86_400_000
  if (!opts.pitch && spanDays > 7) {
    warnings.push(`the chat spans ${Math.round(spanDays)} days: words like "ศุกร์นี้" are read against the Summary time, the last day. Narrow it with --from and --to.`)
  }
  // A mention whose name is not a sender (LINE shows the name at mention time, which can
  // differ from the sender name in the export): it may still be a real name.
  const personaNames = new Set(Object.values(names))
  const leftover = new Set<string>()
  for (const m of messages) for (const at of m.text.match(/@[^\s@]+/g) ?? []) if (!personaNames.has(at.slice(1))) leftover.add(at)
  if (leftover.size > 0) {
    warnings.push(`mentions that are not a sender name (add them with --rename): ${[...leftover].join(' ')}`)
  }
  warnings.push('nicknames inside the text are not replaced: read the output and add them with --rename before sharing it.')
  if (parsed.problems.length > 0) {
    warnings.push(`${parsed.problems.length} lines could not be read (first at line ${parsed.problems[0].line}). Send a sample so the parser learns the format.`)
  }

  const scenario: Scenario = {
    name: opts.name,
    feature: opts.pitch ? 'Pitch script (imported chat)' : 'Imported LINE chat',
    description: `Imported from a LINE export: ${messages.length} messages, ${senders.length} people. Fill expectedTasks before a real-model run.`,
    startAt: start.toISOString(),
    group: {
      lineGroupId: `Ce2e${hexTail('group', opts.name)}`,
      name: `E2E ${opts.name}`,
      workDescription: opts.work ?? 'งานของทีม (แชตจริงที่นำเข้า)',
    },
    personas,
    messages,
    summaryCommand: { persona: ownerKey, minute: last + 1, text: 'NongJoDII สรุปหน่อย' },
    expectedTasks: [],
    fakeModelAnswer: { summary: 'นำเข้าจากแชตจริง', tasks: [] },
    expect: { storedMessages: messages.length + 1, summaries: 1, candidates: 0, replyHasReviewButton: false },
  }
  return { scenario, names, warnings }
}

// ---- CLI ----

function parseArgs(argv: string[]): { file: string; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {}
  let file = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++ } else flags[a.slice(2)] = true
    } else if (!file) file = a
  }
  return { file, flags }
}

async function main(): Promise<void> {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { basename, join } = await import('node:path')
  const { file, flags } = parseArgs(process.argv.slice(2))
  if (!file) {
    console.error('usage: node e2e/import-chat.ts <chat.txt> [--out dir] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--pitch --start iso --max-lines n]')
    process.exit(2)
  }
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const rename = Object.fromEntries((str('rename') ?? '').split(',').filter(Boolean).map((p) => p.split('=') as [string, string]))
  const name = str('name') ?? `real-${basename(file).replace(/\.txt$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'chat'}`
  const parsed = parseLineExport(readFileSync(file, 'utf8'))
  const result = toScenario(parsed, {
    name, from: str('from'), to: str('to'), owner: str('owner'), rename, keepLinks: flags['keep-links'] === true, work: str('work'),
    pitch: flags.pitch ? { start: str('start') ? new Date(str('start')!) : new Date(), maxLines: Number(str('max-lines') ?? 10) } : undefined,
  })
  const out = str('out') ?? 'e2e/private'
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(result.scenario, null, 2)}\n`)
  writeFileSync(join(out, `${name}.names.json`), `${JSON.stringify(result.names, null, 2)}\n`)
  const skipped = Object.entries(parsed.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none' // whole file
  console.log(`wrote ${join(out, `${name}.json`)}: ${result.scenario.messages.length} messages, ${Object.keys(result.names).length} people`)
  console.log(`skipped in the file: ${skipped}; system lines ${parsed.systemLines}`)
  console.log(`name map (private): ${join(out, `${name}.names.json`)}`)
  for (const w of result.warnings) console.log(`warning: ${w}`)
}

if (process.argv[1] && /import-chat\.mts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
