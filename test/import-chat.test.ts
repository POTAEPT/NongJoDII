import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLineExport, PERSONA_NAMES, toScenario } from '../e2e/import-chat.mjs'

// #118: a LINE chat export becomes an e2e scenario. The sample below is made up, in the
// format of a real export from the Thai app (2026-11-16): a header, Thai day lines, tab
// separated messages, unquoted multi-line messages and placeholders. Never commit a real one.

const SAMPLE = [
  '[LINE] ประวัติการแชทของ ทีมทดสอบ',
  'บันทึกเมื่อ 16/11/2026 18:30',
  '',
  'ศ. 13/11/2026',
  '21:36\tก้อย\t[สติกเกอร์]',
  '21:39\tก้อย\t@! Max แม็ก ใครทำสไลด์ได้บ้าง',
  '21:40\t! Max แม็ก\tเดี๋ยวทำให้',
  'ส่งศุกร์นี้นะ',
  '21:41\t! Max แม็ก\t[รูป]',
  '21:42\tโจ้\thttps://drive.google.com/drive/folders/abc ไฟล์อยู่ในนี้',
  '21:43\tโจ้\t(emoji)(emoji)',
  '21:44\tโจ้ ได้ยกเลิกข้อความ',
  '',
  'ส. 14/11/2026',
  '09:05\tก้อย\tโอเค แม็กเก่งมาก',
  '09:06\tก้อย\t"รายงานเราเขียนเอง',
  'ส่งพฤหัส"',
].join('\n')

describe('parseLineExport', () => {
  const parsed = parseLineExport(SAMPLE)

  it('reads the group name, Bangkok times, senders and multi-line messages', () => {
    expect(parsed.groupName).toBe('ทีมทดสอบ')
    expect(parsed.messages.map((m) => [m.sender, m.text])).toEqual([
      ['ก้อย', '@! Max แม็ก ใครทำสไลด์ได้บ้าง'],
      ['! Max แม็ก', 'เดี๋ยวทำให้\nส่งศุกร์นี้นะ'],
      ['โจ้', 'https://drive.google.com/drive/folders/abc ไฟล์อยู่ในนี้'],
      ['ก้อย', 'โอเค แม็กเก่งมาก'],
      ['ก้อย', 'รายงานเราเขียนเอง\nส่งพฤหัส'],
    ])
    // 21:39 Bangkok on 13 Nov is 14:39 UTC.
    expect(parsed.messages[0].at.toISOString()).toBe('2026-11-13T14:39:00.000Z')
  })

  it('drops placeholders and emoji-only messages, counts them, and skips system lines', () => {
    expect(parsed.skipped).toEqual({ sticker: 1, photo: 1, emoji: 1 })
    expect(parsed.systemLines).toBe(1)
    expect(parsed.problems).toEqual([])
  })

  it('reads English and year-first date lines, a Buddhist-era year, and AM/PM times', () => {
    const p = parseLineExport(['Fri, 13/11/2569', 'PM 9:39\tA\thi', '', '2026/11/14(Sat)', 'AM 12:05\tB\tyo'].join('\n'))
    expect(p.messages.map((m) => m.at.toISOString())).toEqual(['2026-11-13T14:39:00.000Z', '2026-11-13T17:05:00.000Z'])
  })

  it('reports a line it cannot place instead of guessing', () => {
    expect(parseLineExport('hello\n21:00\tA\tno day yet').problems.map((x) => x.line)).toEqual([1, 2])
  })
})

describe('toScenario', () => {
  const parsed = parseLineExport(SAMPLE)

  it('gives personas by activity, replaces real names in senders and mentions, and hides links', () => {
    const { scenario, names } = toScenario(parsed, { name: 'real-test' })
    expect(names).toEqual({ 'ก้อย': PERSONA_NAMES[0], '! Max แม็ก': PERSONA_NAMES[1], 'โจ้': PERSONA_NAMES[2] })
    const text = JSON.stringify(scenario)
    for (const real of ['ก้อย', 'Max', 'โจ้', 'drive.google.com']) expect(text).not.toContain(real)
    expect(scenario.messages[0]).toEqual({ id: 'm1', persona: 'p1', minute: 0, text: `@${PERSONA_NAMES[1]} ใครทำสไลด์ได้บ้าง` })
    expect(scenario.messages[2].text).toBe('[ลิงก์] ไฟล์อยู่ในนี้')
    expect(scenario.personas.p1).toMatchObject({ lineName: PERSONA_NAMES[0], owner: true })
    expect(scenario.personas.p1.lineUserId).toMatch(/^Ue2e[0-9a-f]{29}$/)
    expect(scenario.group.lineGroupId).toMatch(/^Ce2e[0-9a-f]{29}$/)
    // The chat's real start, and the command one minute after the last line.
    expect(scenario.startAt).toBe('2026-11-13T14:39:00.000Z')
    expect(scenario.summaryCommand).toEqual({ persona: 'p1', minute: 688, text: 'NongJoDII สรุปหน่อย' })
    expect(scenario.expect.storedMessages).toBe(6)
  })

  it('--rename replaces nicknames the sender names miss; the same file gives the same IDs', () => {
    const a = toScenario(parsed, { name: 'real-test', rename: { 'แม็ก': 'ต้น' } })
    expect(a.scenario.messages[3].text).toBe('โอเค ต้นเก่งมาก')
    expect(toScenario(parsed, { name: 'real-test' }).scenario.personas.p2.lineUserId).toBe(a.scenario.personas.p2.lineUserId)
  })

  it('--from and --to keep Bangkok days; --pitch re-times the lines one minute apart', () => {
    expect(toScenario(parsed, { name: 'x', from: '2026-11-14' }).scenario.messages).toHaveLength(2)
    const pitch = toScenario(parsed, { name: 'x', pitch: { start: new Date('2026-11-18T03:00:00Z'), maxLines: 3 } }).scenario
    expect(pitch.startAt).toBe('2026-11-18T03:00:00.000Z')
    expect(pitch.messages.map((m) => m.minute)).toEqual([0, 1, 2])
  })

  it('warns when the Summary would not read it all, or when the chat spans many days', () => {
    const many = Array.from({ length: 120 }, (_, i) => `10:${String(i % 60).padStart(2, '0')}\tA\tmsg ${i}`)
    const long = parseLineExport(['จ. 1/6/2026', ...many.slice(0, 60), '', 'จ. 15/6/2026', ...many.slice(60)].join('\n'))
    const { warnings } = toScenario(long, { name: 'x' })
    expect(warnings.join('\n')).toContain('only the last 100')
    expect(warnings.join('\n')).toContain('spans 14 days')
  })

  it('names leftover mentions that are not a sender', () => {
    const p = parseLineExport(['ศ. 13/11/2026', '10:00\tA\t@Someone else ช่วยหน่อย'].join('\n'))
    expect(toScenario(p, { name: 'x' }).warnings.join('\n')).toContain('@Someone')
  })
})

describe('the scenario files in git hold no real chat', () => {
  it('e2e/private is ignored except its .gitignore', () => {
    expect(readFileSync(join(__dirname, '..', 'e2e', 'private', '.gitignore'), 'utf8')).toBe('*\n!.gitignore\n')
  })
})
