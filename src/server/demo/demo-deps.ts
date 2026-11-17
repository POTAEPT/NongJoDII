import { randomBytes } from 'node:crypto'
import { GoogleHttpClient } from '@/server/google/client'
import type { Defer, Deps, GooglePort, HandlerConfig } from '@/server/ports'
import { setupCard } from '@/server/setup/card'
import { MemoryStore } from '@/server/store/memory-store'
import { BKK_OFFSET_MS, bangkokIsoWeekday, bangkokParts, bangkokWeekStartLabel } from '@/server/time/bangkok'
import { DemoLine } from './demo-line'
import { DemoLlm } from './demo-llm'
import {
  FALLBACK_GROUPS, fileStem, groupsDir, readGroupFiles, type GroupFile, type GroupFileEntry, type GroupOffset,
} from './group-files'
import type { ChatItem, DemoPersona } from './types'
import { DEMO_LIFF_ID, DemoWorld, type DemoGroup } from './world'

// The /demo composition: the real handlers with an in-memory store, a recording LINE, the
// demo AI and the real Google client. Never imported by src/server/deps.ts, so the
// production routes cannot reach DemoLine (and its demo ID tokens).

export type Demo = {
  /** Bumped on every reset: a background job or script player of an older generation stops. */
  generation: number
  world: DemoWorld
  store: MemoryStore
  line: DemoLine
  llm: DemoLlm
  deps: Deps
  /** Runs a job in the background (not awaited by the response); errors go to the log. */
  defer: Defer
  /** Resolves when no background job is running (jobs they defer included). */
  idle(): Promise<void>
  /** Whether a background job is running. */
  busy(): boolean
}

export type DemoOptions = {
  /** Seed the set-up groups of the groups folder (seedSetUpWorld). false = one group the bot
   *  has never seen (onboarding demo); the folder is not read. */
  setup?: boolean
  /** Replaces the LLM (tests). */
  llm?: DemoLlm
  /** Clock offset from real time (ms) to start at; default 0 (real now). */
  offsetMs?: number
}

type Shared = { config: HandlerConfig; google: GooglePort; demo: Demo | null; generation: number }

const KEY = Symbol.for('nongjodii.demo')

/** Per process, kept across hot reloads and resets: the demo channel secret, the token
 *  key and the Google client. */
function shared(): Shared {
  const g = globalThis as unknown as Record<symbol, Shared | undefined>
  let s = g[KEY]
  if (!s) {
    const base = (process.env.DEMO_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
    s = {
      config: {
        lineChannelSecret: randomBytes(16).toString('hex'),
        liffId: DEMO_LIFF_ID,
        // Same format as loadConfig's TOKEN_ENCRYPTION_KEY: 32 raw bytes.
        tokenEncryptionKey: randomBytes(32),
        tickSecret: randomBytes(16).toString('hex'),
        appBaseUrl: base,
      },
      google: new GoogleHttpClient({
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
        redirectUri: `${base}/demo/api/google/callback`,
      }),
      demo: null,
      generation: 0,
    }
    g[KEY] = s
  }
  return s
}

export function getDemo(): Demo {
  const s = shared()
  // A demo built by older code (kept on globalThis across a hot reload) has another shape.
  if (!s.demo || !Array.isArray(s.demo.world.groups) || !Array.isArray(s.demo.llm.calls) || !s.demo.deps.decisions) {
    s.demo = buildDemo(s, {})
  }
  return s.demo
}

/** Wipes everything and reseeds. Jobs of the old demo keep their old objects, so they can
 *  no longer change what the UI shows. */
export function resetDemo(opts: DemoOptions = {}): Demo {
  const s = shared()
  s.demo = buildDemo(s, opts)
  return s.demo
}

function buildDemo(s: Shared, opts: DemoOptions): Demo {
  s.generation += 1
  const generation = s.generation
  const world = new DemoWorld(opts.offsetMs ?? 0)
  const store = new MemoryStore()
  store.clock = world.now
  const line = new DemoLine(world)
  const llm = opts.llm ?? new DemoLlm()
  llm.clearCalls()
  llm.clock = world.now
  const deps: Deps = {
    line, llm, decisions: llm, google: s.google, store,
    now: world.now,
    // The photo batch's quiet wait moves the demo clock instead of waiting.
    sleep: async (ms) => world.advance(ms),
    config: s.config,
  }

  const running = new Set<Promise<void>>()
  const defer: Defer = (job) => {
    const p: Promise<void> = Promise.resolve()
      .then(job)
      .catch((err: unknown) => {
        world.addLog('error', `background job failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        running.delete(p)
      })
    running.add(p)
  }

  if (opts.setup !== false) seedSetUpWorld(world, store)

  return {
    generation, world, store, line, llm, deps, defer,
    async idle() {
      while (running.size > 0) await Promise.allSettled([...running])
    },
    busy: () => running.size > 0,
  }
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** The setup default: the groups of src/app/demo/groups/*.json (group-files.ts), in file
 *  order, each set up: a Project (or a Sub group of the parent file's Project), its Owner
 *  confirmed, live Members with nicknames and roles, the bot in the group, the file's Tasks
 *  and chat lines. The first group is selected; the others keep their last two lines unread.
 *  A missing folder (or one with no usable file) seeds the built-in FALLBACK_GROUPS instead.
 *  A bad file or entry is skipped and logged as an error, never thrown. Mirrors
 *  test/harness.ts seedOwnedGroup, plus group_setups.isMain (only confirmOwner sets it). */
function seedSetUpWorld(world: DemoWorld, store: MemoryStore): void {
  const onError = (msg: string) => world.addLog('error', msg)
  const dir = groupsDir()
  const { missing, entries } = readGroupFiles(dir, onError)
  // The constructor's default group goes: the files say which groups exist.
  world.groups = []
  if (!missing) seedGroups(world, store, entries, true, onError)
  if (world.groups.length === 0) {
    if (!missing) onError(`groups: no usable group file in ${dir}; seeded the built-in groups`)
    // Built-in groups have no file on disk to delete.
    seedGroups(world, store, FALLBACK_GROUPS, false, onError)
  }
  const first = world.groups[0]
  world.selectedGroupId = first.lineGroupId
  for (const g of world.groups) g.readCount = g === first ? g.chat.length : Math.max(0, g.chat.length - 2)
}

type Seeded = { projectId: string; owner: DemoPersona; isMain: boolean }

function seedGroups(
  world: DemoWorld, store: MemoryStore, entries: GroupFileEntry[], onDisk: boolean, onError: (msg: string) => void,
): void {
  const seeded = new Map<string, Seeded>()
  // A Sub group listed before its parent waits until the end.
  const later: GroupFileEntry[] = []
  for (const e of entries) {
    if (e.def.mode === 'sub-group' && !seeded.has(fileStem(e.def.parent ?? ''))) later.push(e)
    else seedGroupFile(world, store, e, onDisk, seeded, onError)
  }
  for (const e of later) seedGroupFile(world, store, e, onDisk, seeded, onError)
}

function seedGroupFile(
  world: DemoWorld, store: MemoryStore, { file, def }: GroupFileEntry, onDisk: boolean, seeded: Map<string, Seeded>,
  onError: (msg: string) => void,
): void {
  const skip = (why: string) => onError(`group file ${file}: ${why}; skipped`)
  if (world.groupById(def.lineGroupId)) return skip(`lineGroupId ${def.lineGroupId} is used by another group`)
  const unknown = def.members.filter((k) => !world.persona(k))
  if (unknown.length) onError(`group file ${file}: unknown persona(s) ${unknown.join(', ')} left out`)
  const members = [...new Set(def.members.filter((k) => world.persona(k)))]
  if (members.length === 0) return skip('no known member')
  if (def.setUp === false) return seedNotSetUp(world, store, file, def, members, onDisk)

  let projectId: string
  let owner: DemoPersona | undefined
  if (def.mode === 'sub-group') {
    const parent = seeded.get(fileStem(def.parent ?? ''))
    if (!parent) return skip(`parent ${def.parent} is missing or was skipped`)
    if (!parent.isMain) return skip(`parent ${def.parent} is not a main group`)
    // One admin per Project: a Sub group's Owner is the Project's Owner.
    owner = parent.owner
    if (def.owner !== undefined && def.owner !== owner.key) onError(`group file ${file}: owner ${def.owner} is not the Project's Owner; using ${owner.key}`)
    if (!members.includes(owner.key)) return skip(`the Project's Owner (${owner.key}) is not a member`)
    projectId = parent.projectId
  } else {
    owner = world.persona(def.owner ?? '')
    if (!owner || !members.includes(owner.key)) return skip(`owner ${def.owner} is not a member`)
    projectId = store.seedProject(owner.lineUserId).id
  }
  const isMain = def.mode !== 'sub-group'
  seeded.set(fileStem(file), { projectId, owner, isMain })

  const now = world.now()
  const wg = world.addGroup({ lineGroupId: def.lineGroupId, name: def.name, members, botInGroup: true, file: onDisk ? file : null })
  const row = store.seedGroup({
    lineGroupId: wg.lineGroupId, projectId, name: def.name,
    nominatedOwnerLineUserId: owner.lineUserId, ownerConfirmedAt: now, workDescription: def.workDescription ?? null,
  })
  markSetup(store, row.id, isMain, owner.lineUserId, now)
  for (const p of world.membersInGroup(wg)) seedLiveMember(store, row.id, p, true)
  if (def.weekly) {
    store.seedSchedule(row.id, 'dayOffset' in def.weekly
      ? weeklySlotAfter(now, def.weekly.dayOffset)
      : { weeklySummaryWeekday: def.weekly.weekday, weeklySummaryTime: withSeconds(def.weekly.time) })
  }
  if (def.dailyReminderTime) store.seedSchedule(row.id, { dailyReminderTime: withSeconds(def.dailyReminderTime) })

  const announcedAt = new Date(now.getTime() - 3 * HOUR_MS)
  for (const t of def.tasks ?? []) {
    let assignee: string | null = null
    if (t.assignee) {
      assignee = world.persona(t.assignee)?.lineUserId ?? null
      if (!assignee) onError(`group file ${file}: task "${t.title}": unknown assignee ${t.assignee}, left unassigned`)
    }
    const due = t.due ? atOffset(now, t.due) : null
    let doneAt: Date | null = null
    if (t.status === 'done') {
      doneAt = t.doneAt
        ? atOffset(now, t.doneAt)
        : new Date(Math.min(due?.getTime() ?? Infinity, now.getTime() - HOUR_MS))
    }
    const lastActivityAt = doneAt ?? (t.lastUpdate ? atOffset(now, t.lastUpdate) : announcedAt)
    const task = store.seedTask({
      groupId: row.id, title: t.title, createdByLineUserId: owner.lineUserId, assigneeLineUserId: assignee,
      status: t.status, dueAt: due, announcedAt,
    })
    // done_at and last activity are store columns TaskRow does not carry.
    const record = store.tables.tasks.find((x) => x.id === task.id)
    if (record) Object.assign(record, { doneAt, lastActivityAt })
  }
  seedChat(world, wg, (def.chat ?? []).filter((c) => {
    if (world.persona(c.persona)) return true
    onError(`group file ${file}: chat line by unknown persona ${c.persona} left out`)
    return false
  }))
}

/** A group whose setup never completed, as LINE left it: the bot in the group with its setup
 *  card (the join card asks everyone to say hi), no Project and no known Member, since the
 *  bot learns people only from their messages (#151). */
function seedNotSetUp(
  world: DemoWorld, store: MemoryStore, file: string, def: GroupFile, members: string[], onDisk: boolean,
): void {
  const wg = world.addGroup({ lineGroupId: def.lineGroupId, name: def.name, members, botInGroup: true, file: onDisk ? file : null })
  wg.fileNotSetUp = onDisk
  const row = store.seedGroup({ lineGroupId: wg.lineGroupId, name: def.name })
  world.system('NongJoDII เข้าร่วมกลุ่ม', wg)
  world.addChat({ from: 'bot', via: 'reply', message: setupCard({ liffId: DEMO_LIFF_ID, groupId: row.id }) }, wg)
}

/** `now` moved by the offset; `hour` then pins that day's Bangkok hour; `thisWeek` keeps it
 *  at or after this Bangkok week's Monday 00:00. */
function atOffset(now: Date, o: GroupOffset & { thisWeek?: boolean }): Date {
  let t = now.getTime() + (o.days ?? 0) * DAY_MS + (o.hours ?? 0) * HOUR_MS + (o.minutes ?? 0) * 60_000
  if (o.hour !== undefined) t = Math.floor((t + BKK_OFFSET_MS) / DAY_MS) * DAY_MS + o.hour * HOUR_MS - BKK_OFFSET_MS
  if (o.thisWeek) t = Math.max(t, Date.parse(`${bangkokWeekStartLabel(now)}T00:00:00+07:00`))
  return new Date(t)
}

const withSeconds = (time: string): string => (time.length === 5 ? `${time}:00` : time)

/** The weekly slot `dayOffset` days after `now`'s Bangkok day, at the next full Bangkok hour
 *  (23:00 at the latest). Near the reset, so the Owner card's "done this week" and "stale"
 *  read the seeded Tasks as they are, and the two Projects' slots differ by a day, so
 *  POST weekly reaches one Project's slot without the other's. */
function weeklySlotAfter(now: Date, dayOffset: number): { weeklySummaryWeekday: number; weeklySummaryTime: string } {
  const hour = Math.min(23, bangkokParts(now).hh + 1)
  const weekday = ((bangkokIsoWeekday(now) - 1 + dayOffset) % 7) + 1
  return { weeklySummaryWeekday: weekday, weeklySummaryTime: `${String(hour).padStart(2, '0')}:00:00` }
}

function seedChat(world: DemoWorld, group: DemoGroup, lines: NonNullable<GroupFile['chat']>): void {
  const now = world.now().getTime()
  for (const { persona, text, minutesAgo } of lines) {
    const item: Omit<ChatItem, 'id'> = {
      at: new Date(now - minutesAgo * 60_000).toISOString(), from: 'user', persona, message: { type: 'text', text },
    }
    world.addChat(item, group)
  }
}

/** The group_setups row setup writes: main group or not, the Owner nomination. */
function markSetup(store: MemoryStore, groupId: string, isMain: boolean, owner: string, at: Date): void {
  store.tables.group_setups.push({
    groupId, isMain, featureSaveFiles: true, ownerNominatedByLineUserId: owner, ownerNominatedAt: at,
  })
}

/** A live Member as the store holds one. withProfile: nicknames and role (what the setup
 *  form saves); false: a Member the bot only knows by LINE name. */
export function seedLiveMember(store: MemoryStore, groupId: string, p: DemoPersona, withProfile: boolean): void {
  store.seedMember({
    groupId, lineUserId: p.lineUserId, displayName: p.lineName,
    ...(withProfile ? { nicknames: p.nicknames ?? [], ...(p.role ? { role: p.role } : {}) } : {}),
  })
}
