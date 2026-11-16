import { randomBytes } from 'node:crypto'
import { GoogleHttpClient } from '@/server/google/client'
import type { Defer, Deps, GooglePort, HandlerConfig } from '@/server/ports'
import { MemoryStore } from '@/server/store/memory-store'
import { DemoLine } from './demo-line'
import { DemoLlm } from './demo-llm'
import type { ChatItem, DemoPersona } from './types'
import { DEMO_GROUP_NAME, DEMO_LIFF_ID, DEMO_WORK_DESCRIPTION, DemoWorld, type DemoGroup } from './world'

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
  /** Seed three set-up groups with Nont in all (seedSetUpWorld). false = one group the bot
   *  has never seen (onboarding demo). */
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
  if (!s.demo || !Array.isArray(s.demo.world.groups) || !Array.isArray(s.demo.llm.calls)) s.demo = buildDemo(s, {})
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
    line, llm, google: s.google, store,
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

type SeedTask = { title: string; assignee: string | null; dueInMs: number; status: 'not_assigned' | 'in_process' | 'done' }
type SeedSpec = {
  name: string; members: string[]; workDescription: string
  /** The main group of a new Project, or a Sub group of the spec at this index. */
  subGroupOf?: number
  tasks: SeedTask[]
  /** Chat lines, oldest first: [persona key, text, minutes ago]. */
  chat: Array<[string, string, number]>
}

/** The pitch's world: one PM (Nont) in three groups across two Projects. */
const SEED: SeedSpec[] = [
  {
    name: DEMO_GROUP_NAME, members: ['nont', 'tae', 'bomb', 'jeff'], workDescription: DEMO_WORK_DESCRIPTION,
    tasks: [
      { title: 'อัปเดตสไลด์พิตช์รอบสุดท้าย', assignee: 'bomb', dueInMs: DAY_MS, status: 'in_process' },
      { title: 'เขียนสคริปต์พูดพิตช์ 5 นาที', assignee: 'jeff', dueInMs: -DAY_MS, status: 'in_process' },
      { title: 'ซ้อมพิตช์กับอาจารย์ที่ปรึกษา', assignee: 'nont', dueInMs: -2 * DAY_MS, status: 'done' },
      { title: 'สรุปตัวเลข break-even ใส่สไลด์', assignee: null, dueInMs: 3 * DAY_MS, status: 'not_assigned' },
    ],
    chat: [
      ['nont', 'พรุ่งนี้ซ้อมพิตช์กันกี่โมงดี', 95],
      ['jeff', 'บ่ายสองได้ไหมครับ', 90],
      ['bomb', 'ได้ค่ะ เดี๋ยวเอาสไลด์เวอร์ชันใหม่มาด้วย', 88],
    ],
  },
  {
    name: 'ทีม Dev', members: ['nont', 'tae'], workDescription: 'พัฒนาแอปเดโม NongJoDII ให้พร้อมพิตช์', subGroupOf: 0,
    tasks: [
      { title: 'ทำหน้า Dashboard ให้แสดงผลบนมือถือ', assignee: 'tae', dueInMs: 2 * DAY_MS, status: 'in_process' },
      { title: 'แก้บั๊กปุ่มยืนยันงานไม่ตอบสนอง', assignee: 'tae', dueInMs: -5 * HOUR_MS, status: 'in_process' },
      { title: 'ตั้งค่า LINE webhook บนเซิร์ฟเวอร์จริง', assignee: 'tae', dueInMs: -DAY_MS, status: 'done' },
    ],
    chat: [
      ['tae', 'บั๊กปุ่มยืนยันงานยังแก้ไม่เสร็จนะพี่', 70],
      ['nont', 'โอเค ขอให้ทันก่อนซ้อมใหญ่นะ', 65],
      ['tae', 'รับทราบครับ', 64],
    ],
  },
  {
    name: 'ลูกค้า ร้านกาแฟ', members: ['nont', 'bomb', 'jeff'], workDescription: 'ทำแบรนด์และเพจให้ร้านกาแฟเปิดใหม่',
    tasks: [
      { title: 'ออกแบบโลโก้ร้านกาแฟ 3 แบบ', assignee: 'bomb', dueInMs: DAY_MS, status: 'in_process' },
      { title: 'ถ่ายรูปเมนูใหม่ลงเพจ', assignee: 'jeff', dueInMs: -DAY_MS, status: 'in_process' },
      { title: 'ส่งใบเสนอราคาให้ลูกค้า', assignee: 'nont', dueInMs: -3 * DAY_MS, status: 'done' },
      { title: 'นัดคุยลูกค้าเรื่องโปรเปิดร้าน', assignee: null, dueInMs: 4 * DAY_MS, status: 'not_assigned' },
    ],
    chat: [
      ['jeff', 'ลูกค้าอยากได้โทนสีอบอุ่นกว่าเดิมครับ', 50],
      ['bomb', 'เดี๋ยวลองปรับโลโก้เป็นโทนน้ำตาลดูค่ะ', 45],
      ['nont', 'ดีเลย ส่งให้ลูกค้าดูภายในพรุ่งนี้นะ', 40],
      ['jeff', 'รูปเมนูขอเลื่อนไปวันศุกร์ได้ไหมครับ', 12],
    ],
  },
]

/** The setup default: three groups with Nont in all, each with a Project (or a Sub group of
 *  one), Nont the confirmed Owner, live Members, Tasks and a few chat lines. The bot is in
 *  every group. Mirrors test/harness.ts seedOwnedGroup, plus group_setups.isMain for the
 *  main groups (only confirmOwner sets it in the store). */
function seedSetUpWorld(world: DemoWorld, store: MemoryStore): void {
  const now = world.now()
  const owner = world.personas.find((p) => p.owner) ?? world.personas[0]
  const projects: string[] = []
  SEED.forEach((spec, i) => {
    const wg = i === 0 ? world.groups[0] : world.addGroup({ name: spec.name, members: spec.members })
    wg.name = spec.name
    wg.members = new Set(spec.members)
    wg.botInGroup = true
    const projectId = spec.subGroupOf !== undefined ? projects[spec.subGroupOf] : store.seedProject(owner.lineUserId).id
    projects.push(projectId)
    const row = store.seedGroup({
      lineGroupId: wg.lineGroupId, projectId, name: spec.name,
      nominatedOwnerLineUserId: owner.lineUserId, ownerConfirmedAt: now, workDescription: spec.workDescription,
    })
    markSetup(store, row.id, spec.subGroupOf === undefined, owner.lineUserId, now)
    for (const p of world.membersInGroup(wg)) seedLiveMember(store, row.id, p, true)
    for (const t of spec.tasks) {
      const assignee = t.assignee ? world.persona(t.assignee)?.lineUserId ?? null : null
      const due = new Date(now.getTime() + t.dueInMs)
      store.seedTask({
        groupId: row.id, title: t.title, createdByLineUserId: owner.lineUserId, assigneeLineUserId: assignee,
        status: t.status, dueAt: due, announcedAt: new Date(now.getTime() - 3 * HOUR_MS),
        ...(t.status === 'done' ? { doneAt: new Date(Math.min(due.getTime(), now.getTime() - HOUR_MS)) } : {}),
      })
    }
    seedChat(world, wg, spec.chat)
    // The other groups keep their last two lines unread, so the chat list shows badges.
    wg.readCount = i === 0 ? wg.chat.length : Math.max(0, wg.chat.length - 2)
  })
}

function seedChat(world: DemoWorld, group: DemoGroup, lines: SeedSpec['chat']): void {
  const now = world.now().getTime()
  for (const [persona, text, minutesAgo] of lines) {
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

/** Makes a group a Sub group of `projectId`: its Owner is the Project's Owner (the one-admin
 *  rule, check_same_owner), confirmed now. No user-facing path does this yet (the "Sub group
 *  attach flow" is not built), so the demo writes the store as the seed does. */
export function attachSubGroup(store: MemoryStore, groupId: string, projectId: string, owner: string, at: Date): void {
  const row = store.tables.groups.find((g) => g.id === groupId)
  if (!row) throw new Error(`no group ${groupId}`)
  row.projectId = projectId
  row.nominatedOwnerLineUserId = owner
  row.ownerConfirmedAt = at
  row.ownerLeftAt = null
  const setup = store.tables.group_setups.find((r) => r.groupId === groupId)
  if (setup) Object.assign(setup, { isMain: false, ownerNominatedByLineUserId: owner, ownerNominatedAt: at })
  else markSetup(store, groupId, false, owner, at)
}
