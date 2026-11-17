import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The seeded groups as files (docs/demo-contract.md, "Groups"): one JSON file per group in
// src/app/demo/groups/, read on every reset (and on the first build after a server start),
// sorted by file name. "สร้างกลุ่ม" writes one (not set up), setup-files.ts records its setup
// once it completes, and delete-group removes one. Synchronous: a reset
// builds the demo synchronously.

/** A time relative to the reset instant: days, hours and minutes added to it; `hour` then
 *  pins the Bangkok clock hour (minute 0) of the day reached. */
export type GroupOffset = { days?: number; hours?: number; minutes?: number; hour?: number }

export type GroupFileTask = {
  title: string
  /** Persona key, or null (not assigned). */
  assignee: string | null
  /** Absent: no deadline. */
  due?: GroupOffset
  status: 'not_assigned' | 'in_process' | 'done'
  /** done only. thisWeek: never before this Bangkok week's Monday 00:00 (the Owner card's
   *  "done this week"). Absent: an hour before now, or the due if that is earlier. */
  doneAt?: GroupOffset & { thisWeek?: boolean }
  /** Last update of an open Task; 6+ days back makes it stale. A done Task's last update is
   *  its done-at. Absent: announced (3 h ago). */
  lastUpdate?: GroupOffset
}

export type GroupFile = {
  name: string
  /** Stable LINE group id: 'C' + letters and digits. */
  lineGroupId: string
  /** Persona keys. */
  members: string[]
  /** false: the bot is in the group but its setup form was never completed ("สร้างกลุ่ม"
   *  writes this). Reset brings it back with the bot's setup card and no known Members; owner
   *  and mode are then unused. Absent or true: set up, as owner and mode say. */
  setUp?: boolean
  /** Persona key of the confirmed Owner. A Sub group's Owner is its Project's Owner. */
  owner?: string
  mode?: 'new-project' | 'sub-group'
  /** sub-group: the parent's file name (with or without .json). */
  parent?: string
  workDescription?: string | null
  /** The weekly slot. dayOffset: that many days after the reset day, at the next full
   *  Bangkok hour (23:00 at the latest). weekday (1 = Monday) + time: fixed. Absent: the
   *  schema default (Monday 09:00). */
  weekly?: { dayOffset: number } | { weekday: number; time: string }
  /** The daily reminder time, 'HH:MM:SS'. Absent: the schema default. */
  dailyReminderTime?: string
  tasks?: GroupFileTask[]
  /** Chat lines, oldest first. */
  chat?: Array<{ persona: string; text: string; minutesAgo: number }>
}

export type GroupFileEntry = { file: string; def: GroupFile }

const DEFAULT_GROUPS_DIR = path.join(process.cwd(), 'src', 'app', 'demo', 'groups')
let groupsDirOverride: string | undefined
/** The folder: setGroupsDir's, else DEMO_GROUPS_DIR (test/setup.ts), else src/app/demo/groups. */
export function groupsDir(): string {
  return groupsDirOverride ?? process.env.DEMO_GROUPS_DIR ?? DEFAULT_GROUPS_DIR
}
/** Tests point the loader at a temp folder; no argument restores the default. */
export function setGroupsDir(dir?: string): void {
  groupsDirOverride = dir
}

/** A plain file name (without .json): letters, digits, - and _, no leading dot. */
export const GROUP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const LINE_GROUP_ID = /^C[A-Za-z0-9]{1,64}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/
const NAME_MAX = 50
const STATUSES = ['not_assigned', 'in_process', 'done']

/** Strips .json: '01-main.json' and '01-main' name the same file. */
export const fileStem = (f: string): string => f.replace(/\.json$/, '')

/** Every valid group file in `dir`, sorted by file name. missing: the folder does not exist
 *  (the caller falls back to the built-in seed). A bad file is skipped and reported. */
export function readGroupFiles(dir: string, onError: (msg: string) => void): { missing: boolean; entries: GroupFileEntry[] } {
  let names: string[]
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true, entries: [] }
    onError(`groups: cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    return { missing: false, entries: [] }
  }
  const entries: GroupFileEntry[] = []
  for (const file of names) {
    if (!GROUP_FILE_NAME.test(fileStem(file))) {
      onError(`group file ${file}: name must be letters, digits, - or _ only`)
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8'))
    } catch (err) {
      onError(`group file ${file}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    const def = asGroupFile(parsed)
    if (typeof def === 'string') onError(`group file ${file}: ${def}`)
    else entries.push({ file, def })
  }
  return { missing: false, entries }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

function asOffset(x: unknown): GroupOffset | null {
  if (!isObj(x)) return null
  for (const k of ['days', 'hours', 'minutes'] as const) if (x[k] !== undefined && !isNum(x[k])) return null
  if (x.hour !== undefined && !(Number.isInteger(x.hour) && (x.hour as number) >= 0 && (x.hour as number) <= 23)) return null
  if (x.thisWeek !== undefined && typeof x.thisWeek !== 'boolean') return null
  return x as GroupOffset
}

/** The file's shape, or why it is not a group file. Persona keys are checked at seed time. */
export function asGroupFile(x: unknown): GroupFile | string {
  if (!isObj(x)) return 'not a JSON object'
  if (typeof x.name !== 'string' || x.name.trim() === '' || x.name.length > NAME_MAX) return `name must be 1-${NAME_MAX} characters`
  if (typeof x.lineGroupId !== 'string' || !LINE_GROUP_ID.test(x.lineGroupId)) return 'lineGroupId must be C followed by letters or digits'
  if (!Array.isArray(x.members) || x.members.length === 0 || !x.members.every((m) => typeof m === 'string')) return 'members must be a non-empty list of persona keys'
  if (x.setUp !== undefined && typeof x.setUp !== 'boolean') return 'setUp must be true or false'
  if (x.setUp !== false) {
    if (typeof x.owner !== 'string') return 'owner (a persona key) is required'
    if (x.mode !== 'new-project' && x.mode !== 'sub-group') return "mode must be 'new-project' or 'sub-group'"
    if (x.mode === 'sub-group' && (typeof x.parent !== 'string' || !GROUP_FILE_NAME.test(fileStem(x.parent)))) return 'a sub-group needs parent (a file name)'
  }
  if (x.workDescription !== undefined && x.workDescription !== null && typeof x.workDescription !== 'string') return 'workDescription must be text'
  if (x.weekly !== undefined) {
    const w = x.weekly
    const relative = isObj(w) && Number.isInteger(w.dayOffset) && (w.dayOffset as number) >= 0
    const fixed = isObj(w) && Number.isInteger(w.weekday) && (w.weekday as number) >= 1 && (w.weekday as number) <= 7
      && typeof w.time === 'string' && TIME.test(w.time)
    if (!relative && !fixed) return 'weekly must be {dayOffset} or {weekday, time}'
  }
  if (x.dailyReminderTime !== undefined && (typeof x.dailyReminderTime !== 'string' || !TIME.test(x.dailyReminderTime))) return 'dailyReminderTime must be HH:MM:SS'
  if (x.tasks !== undefined) {
    if (!Array.isArray(x.tasks)) return 'tasks must be a list'
    for (const [i, t] of x.tasks.entries()) {
      if (!isObj(t) || typeof t.title !== 'string' || t.title.trim() === '') return `tasks[${i}]: title is required`
      if (t.assignee !== null && typeof t.assignee !== 'string') return `tasks[${i}]: assignee must be a persona key or null`
      if (!STATUSES.includes(t.status as string)) return `tasks[${i}]: status must be ${STATUSES.join(', ')}`
      for (const k of ['due', 'doneAt', 'lastUpdate'] as const) {
        if (t[k] !== undefined && !asOffset(t[k])) return `tasks[${i}]: ${k} must be an offset like {"days": -2, "hour": 17}`
      }
    }
  }
  if (x.chat !== undefined) {
    if (!Array.isArray(x.chat)) return 'chat must be a list'
    for (const [i, c] of x.chat.entries()) {
      if (!isObj(c) || typeof c.persona !== 'string' || typeof c.text !== 'string' || !isNum(c.minutesAgo)) {
        return `chat[${i}]: needs persona, text and minutesAgo`
      }
    }
  }
  return x as unknown as GroupFile
}

/** A short ascii file-name part: 'Team Event!' -> 'team-event'; Thai (no ascii) -> 'group'. */
export function groupSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '')
  return s || 'group'
}

/** Writes `def` as `NN-<slug>.json`, NN one past the highest number in the folder. Throws
 *  when the folder is missing (it is never created: a missing folder means the built-in seed). */
export function writeGroupFile(dir: string, def: GroupFile): string {
  const nums = readdirSync(dir).map((f) => /^(\d+)-/.exec(f)?.[1]).filter((n): n is string => n !== undefined).map(Number)
  let n = (nums.length ? Math.max(...nums) : 0) + 1
  for (;;) {
    const file = `${String(n).padStart(2, '0')}-${groupSlug(def.name)}.json`
    try {
      writeFileSync(path.join(dir, file), `${JSON.stringify(def, null, 2)}\n`, { flag: 'wx' })
      return file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      n += 1
    }
  }
}

/** Replaces an existing group file's content (the setup outcome, setup-files.ts). */
export function rewriteGroupFile(dir: string, file: string, def: GroupFile): void {
  if (!GROUP_FILE_NAME.test(fileStem(file))) throw new Error(`bad group file name ${file}`)
  writeFileSync(path.join(dir, `${fileStem(file)}.json`), `${JSON.stringify(def, null, 2)}\n`)
}

/** Removes a group file; a file already gone is fine. */
export function deleteGroupFile(dir: string, file: string): void {
  if (!GROUP_FILE_NAME.test(fileStem(file))) throw new Error(`bad group file name ${file}`)
  try {
    unlinkSync(path.join(dir, `${fileStem(file)}.json`))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** The built-in seed, used only when the folder is missing (or yields no usable group). The
 *  three files in src/app/demo/groups/ hold the same definitions. */
export const FALLBACK_GROUPS: GroupFileEntry[] = [
  {
    file: '01-main.json',
    def: {
      name: 'ทีมพิตช์ NongJoDII', lineGroupId: 'Cdemo0000000000000000000000000001',
      members: ['nont', 'tae', 'bomb', 'jeff'], owner: 'nont', mode: 'new-project',
      workDescription: 'เตรียมงานพิตช์รอบสุดท้ายของทีม NongJoDII',
      weekly: { dayOffset: 0 },
      tasks: [
        // Seed Tasks must not overlap the scripts' work (slides, speech, rehearsal, break-even,
        // demo app, poster, room): the Summary never proposes a Task the group already has (#108).
        { title: 'ทำแบบสอบถามผู้ใช้ 20 คน', assignee: 'bomb', due: { days: 1 }, status: 'in_process' },
        { title: 'สรุปผลสัมภาษณ์ลูกค้า 5 ราย', assignee: 'jeff', due: { days: -1 }, status: 'in_process', lastUpdate: { days: -6 } },
        { title: 'ส่งแบบฟอร์มลงทะเบียนแข่งขัน', assignee: 'nont', due: { days: -2 }, status: 'done', doneAt: { hours: -2, thisWeek: true } },
        { title: 'ตั้งค่าโดเมนเว็บไซต์ทีม', assignee: null, due: { days: 3 }, status: 'not_assigned' },
      ],
      chat: [
        { persona: 'nont', text: 'แบบสอบถามได้คำตอบกี่คนแล้ว', minutesAgo: 95 },
        { persona: 'jeff', text: 'ตอนนี้ 12 คนครับ', minutesAgo: 90 },
        { persona: 'bomb', text: 'โอเค ไว้ค่อยดูกันต่อ', minutesAgo: 88 },
      ],
    },
  },
  {
    file: '02-dev.json',
    def: {
      name: 'ทีม Dev', lineGroupId: 'Cdemo0000000000000000000000000002',
      members: ['nont', 'tae'], owner: 'nont', mode: 'sub-group', parent: '01-main.json',
      workDescription: 'พัฒนาแอปเดโม NongJoDII ให้พร้อมพิตช์',
      tasks: [
        { title: 'ทำหน้า Dashboard ให้แสดงผลบนมือถือ', assignee: 'tae', due: { days: 2 }, status: 'in_process' },
        { title: 'แก้บั๊กปุ่มยืนยันงานไม่ตอบสนอง', assignee: 'tae', due: { hours: -5 }, status: 'in_process' },
        { title: 'ตั้งค่า LINE webhook บนเซิร์ฟเวอร์จริง', assignee: 'tae', due: { days: -1 }, status: 'done', doneAt: { hours: -2, thisWeek: true } },
      ],
      chat: [
        { persona: 'tae', text: 'บั๊กปุ่มยืนยันงานยังแก้ไม่เสร็จนะพี่', minutesAgo: 70 },
        { persona: 'nont', text: 'โอเค ขอให้ทันก่อนซ้อมใหญ่นะ', minutesAgo: 65 },
        { persona: 'tae', text: 'รับทราบครับ', minutesAgo: 64 },
      ],
    },
  },
  {
    file: '03-cafe.json',
    def: {
      name: 'ลูกค้า ร้านกาแฟ', lineGroupId: 'Cdemo0000000000000000000000000003',
      members: ['nont', 'bomb', 'jeff'], owner: 'nont', mode: 'new-project',
      workDescription: 'ทำแบรนด์และเพจให้ร้านกาแฟเปิดใหม่',
      weekly: { dayOffset: 1 },
      tasks: [
        { title: 'ออกแบบโลโก้ร้านกาแฟ 3 แบบ', assignee: 'bomb', due: { days: 1 }, status: 'in_process', lastUpdate: { days: -6 } },
        { title: 'ถ่ายรูปเมนูใหม่ลงเพจ', assignee: 'jeff', due: { days: -1 }, status: 'in_process' },
        { title: 'ส่งใบเสนอราคาให้ลูกค้า', assignee: 'nont', due: { days: -3 }, status: 'done', doneAt: { hours: -2, thisWeek: true } },
        { title: 'นัดคุยลูกค้าเรื่องโปรเปิดร้าน', assignee: null, due: { days: 4 }, status: 'not_assigned' },
      ],
      chat: [
        { persona: 'jeff', text: 'ลูกค้าอยากได้โทนสีอบอุ่นกว่าเดิมครับ', minutesAgo: 50 },
        { persona: 'bomb', text: 'เดี๋ยวลองปรับโลโก้เป็นโทนน้ำตาลดูค่ะ', minutesAgo: 45 },
        { persona: 'nont', text: 'ดีเลย ส่งให้ลูกค้าดูภายในพรุ่งนี้นะ', minutesAgo: 40 },
        { persona: 'jeff', text: 'รูปเมนูขอเลื่อนไปวันศุกร์ได้ไหมครับ', minutesAgo: 12 },
      ],
    },
  },
]
