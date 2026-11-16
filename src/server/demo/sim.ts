import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LineEvent, LineMention } from '@/server/line/types'
import { runTick } from '@/server/tick/run-tick'
import { BKK_OFFSET_MS } from '@/server/time/bangkok'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { attachSubGroup, getDemo, resetDemo, seedLiveMember, type Demo } from './demo-deps'
import { signedWebhookRequest } from './sign'
import type { ChatItem, DemoGroupInfo, DemoPersona, DemoScript, DemoState } from './types'
import { DEMO_LIFF_ID, demoUserId, type DemoGroup } from './world'

// The sim API (docs/demo-contract.md): each function builds the LINE event a real group
// would produce, signs it with the demo secret and hands it to the real webhook handler.
// Every route acts on one group: body.group (a lineGroupId), else the selected group.

export type SimResult = { status: number; body: unknown }

const ok = (body: unknown): SimResult => ({ status: 200, body })
const bad = (error: string, status = 400): SimResult => ({ status, body: { error } })

/** Where the scenario files live. Read at request time from the project root (Next runs
 *  route handlers with process.cwd() there), so a file dropped in shows up without a restart. */
const DEFAULT_SCRIPTS_DIR = path.join(process.cwd(), 'src', 'app', 'demo', 'scripts')
let scriptsDir = DEFAULT_SCRIPTS_DIR
/** Tests point the loader at a temp folder; no argument restores the default. */
export function setScriptsDir(dir?: string): void {
  scriptsDir = dir ?? DEFAULT_SCRIPTS_DIR
}
/** A script name is a plain file name: no path separators, no dots-only, no leading dot. */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const GROUP_NAME_MAX = 50

/** Every sim route. GET: state, scripts. POST: the rest. */
export async function runSimAction(action: string, method: string, body: unknown): Promise<SimResult> {
  if (method === 'GET') {
    if (action === 'state') return ok(simState(getDemo()))
    if (action === 'scripts') return ok(await listScripts(getDemo()))
    return bad(`unknown sim route GET ${action}`, 404)
  }
  if (method !== 'POST') return bad('method not allowed', 405)
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const demo = getDemo()
  if (action === 'reset') return ok(simState(resetDemo({ setup: b.setup !== false })))
  if (action === 'create-group') return createGroup(demo, b)
  if (action === 'clock') return clock(demo, b)
  if (action === 'tick') return tick(demo)
  if (action === 'quota') return quota(demo, b)
  if (action === 'persona') return persona(demo, b)
  const g = groupOf(demo, b.group)
  if (isResult(g)) return g
  switch (action) {
    case 'select-group': {
      demo.world.select(g.lineGroupId)
      return ok({ selectedGroup: g.lineGroupId })
    }
    case 'send': return send(demo, g, b)
    case 'message': return send(demo, g, { persona: b.persona, type: 'text', text: b.text })
    case 'postback': return postback(demo, g, b)
    case 'unsend': return unsend(demo, g, b)
    case 'join': return join(demo, g)
    case 'leave-bot': return leaveBot(demo, g)
    case 'member-join': return memberJoin(demo, g, b)
    case 'member-leave': return memberLeave(demo, g, b)
    case 'load-script': return await loadScript(demo, g, b)
    default: return bad(`unknown sim route POST ${action}`, 404)
  }
}

/** body.group: a lineGroupId; missing = the selected group. */
function groupOf(demo: Demo, id: unknown): DemoGroup | SimResult {
  if (id === undefined || id === null || id === '') return demo.world.group
  if (typeof id !== 'string') return bad('group must be a lineGroupId')
  return demo.world.groupById(id) ?? bad(`unknown group ${id}`, 404)
}

export function simState(demo: Demo): DemoState {
  const { world, store, llm } = demo
  const accounts = store.tables.google_accounts
    .filter((a) => a.tokenStatus === 'valid')
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  const selected = world.group
  return {
    now: world.now().toISOString(),
    liffId: DEMO_LIFF_ID,
    group: { lineGroupId: selected.lineGroupId, name: selected.name, botInGroup: selected.botInGroup },
    groups: world.groups.map((g) => groupInfo(demo, g)),
    selectedGroup: selected.lineGroupId,
    personas: world.personas.map(({ key, lineUserId, lineName, role, owner }) => ({
      key, lineUserId, lineName, role, owner, inGroup: selected.members.has(key),
    })),
    quota: { ...world.quota },
    ai: {
      model: llm.model, lastCallFallback: llm.lastCallFallback, busy: llm.busy,
      calls: [...llm.calls], totalUsd: llm.totalUsd,
    },
    google: { connected: accounts.length > 0, email: accounts[0]?.email ?? null },
    chat: selected.chat,
    direct: Object.fromEntries(world.direct),
    log: world.log,
  }
}

function isMainRow(demo: Demo, groupId: string): boolean {
  return demo.store.tables.group_setups.some((r) => r.groupId === groupId && r.isMain)
}

function groupInfo(demo: Demo, g: DemoGroup): DemoGroupInfo {
  const { store, world } = demo
  const row = store.tables.groups.find((r) => r.lineGroupId === g.lineGroupId)
  let projectName: string | null = null
  let isSubGroup = false
  if (row?.projectId) {
    isSubGroup = !isMainRow(demo, row.id)
    const main = store.tables.groups.find((r) => r.projectId === row.projectId && isMainRow(demo, r.id))
    projectName = main?.name ?? row.name ?? g.name
  }
  const last = g.chat.at(-1)
  return {
    lineGroupId: g.lineGroupId, name: g.name, botInGroup: g.botInGroup, projectName, isSubGroup,
    members: g.members.size + (g.botInGroup ? 1 : 0),
    lastMessage: last ? { text: preview(demo, last), at: last.at } : null,
    unread: world.unread(g),
  }
}

/** The chat list's one-line preview, LINE style ("Nont: ..."). */
function preview(demo: Demo, c: ChatItem): string {
  const m = c.message
  let text: string
  if (m.type === 'text') text = m.text
  else if (m.type === 'image') text = '[รูปภาพ]'
  else if (m.type === 'file') text = `[ไฟล์] ${m.fileName}`
  else if (m.type === 'sticker') text = '[สติกเกอร์]'
  else if (m.type === 'system') return m.text
  else text = m.altText
  if (c.unsent) text = 'ยกเลิกข้อความแล้ว'
  const who = c.from === 'bot' ? 'NongJoDII' : demo.world.persona(c.persona ?? '')?.lineName ?? c.persona ?? ''
  return who ? `${who}: ${text}` : text
}

/** The bytes of an uploaded image or file, for /demo/api/sim/content/<messageId>. */
export function simContent(messageId: string): Response {
  const c = getDemo().world.contents.get(messageId)
  if (!c) return new Response('Not Found', { status: 404 })
  return new Response(new Uint8Array(c.data), {
    headers: {
      'Content-Type': c.contentType ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(c.fileName)}`,
      'Cache-Control': 'no-store',
    },
  })
}

// ---- delivery ----

/** Signs the events and runs the webhook handler. LINE delivers nothing to a bot that is
 *  not in the group, so then the event is only logged (a join is always delivered). */
async function deliver(demo: Demo, g: DemoGroup, events: LineEvent[], label: string): Promise<number | null> {
  const where = `[${g.name}] ${label}`
  if (!g.botInGroup && !events.some((e) => e.type === 'join')) {
    demo.world.addLog('event', `${where}: not delivered (bot is not in the group)`)
    return null
  }
  demo.world.addLog('event', where)
  const res = await handleWebhookRequest(signedWebhookRequest(events, demo.deps.config.lineChannelSecret), demo.deps, demo.defer)
  if (res.status !== 200) demo.world.addLog('error', `${where}: webhook answered ${res.status}`)
  return res.status
}

function base(demo: Demo, g: DemoGroup, type: string, userId: string | null, withReply = true): LineEvent {
  const { world } = demo
  const replyToken = withReply ? world.nextId('rt') : null
  if (replyToken) world.replyTokens.set(replyToken, g.lineGroupId)
  return {
    type,
    mode: 'active',
    timestamp: world.eventTime(),
    source: userId === null
      ? { type: 'group', groupId: g.lineGroupId }
      : { type: 'group', groupId: g.lineGroupId, userId },
    ...(replyToken ? { replyToken } : {}),
    webhookEventId: world.nextId('ev'),
    deliveryContext: { isRedelivery: false },
  }
}

function personaOf(demo: Demo, key: unknown): DemoPersona | SimResult {
  if (typeof key !== 'string') return bad('persona is required')
  return demo.world.persona(key) ?? bad(`unknown persona ${key}`, 404)
}
const isResult = (x: unknown): x is SimResult => typeof x === 'object' && x !== null && 'status' in x && 'body' in x

// ---- messages ----

async function send(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  const { world } = demo
  const type = b.type ?? 'text'
  const messageId = world.nextId('')
  const at = new Date(world.eventTime())
  const event = base(demo, g, 'message', p.lineUserId)
  event.timestamp = at.getTime()
  let item: Omit<ChatItem, 'id' | 'at'>
  if (type === 'text') {
    if (typeof b.text !== 'string' || b.text.trim() === '') return bad('text is required')
    let text = b.text
    const mentionees: LineMention[] = []
    const keys = Array.isArray(b.mentions) ? b.mentions.filter((k): k is string => typeof k === 'string') : []
    for (const key of keys) {
      const m = world.persona(key)
      if (!m) return bad(`unknown persona ${key}`, 404)
      // LINE's mention spans point at a literal "@Name" in the text.
      if (!text.includes(`@${m.lineName}`)) text = `@${m.lineName} ${text}`
    }
    for (const key of keys) {
      const m = world.persona(key) as DemoPersona
      const tag = `@${m.lineName}`
      mentionees.push({ index: text.indexOf(tag), length: tag.length, type: 'user', userId: m.lineUserId })
    }
    const quoted = typeof b.quotedMessageId === 'string' && b.quotedMessageId ? b.quotedMessageId : undefined
    event.message = {
      id: messageId, type: 'text', text,
      ...(mentionees.length ? { mention: { mentionees } } : {}),
      ...(quoted ? { quotedMessageId: quoted } : {}),
    }
    item = { from: 'user', persona: p.key, messageId, message: { type: 'text', text, ...(quoted ? { quotedMessageId: quoted } : {}) } }
  } else if (type === 'image' || type === 'file') {
    if (typeof b.dataBase64 !== 'string') return bad('dataBase64 is required')
    const data = new Uint8Array(Buffer.from(b.dataBase64, 'base64'))
    if (data.byteLength > MAX_UPLOAD_BYTES) return bad('file is larger than 25 MB')
    const fileName = typeof b.fileName === 'string' && b.fileName ? b.fileName : (type === 'image' ? 'image.jpg' : 'file')
    const contentType = typeof b.contentType === 'string' && b.contentType ? b.contentType : null
    world.contents.set(messageId, { data, contentType, fileName })
    const url = `/demo/api/sim/content/${messageId}`
    if (type === 'image') {
      const set = b.imageSet as { id?: unknown; index?: unknown; total?: unknown } | undefined
      const imageSet = set && typeof set.id === 'string'
        ? {
            id: set.id,
            ...(typeof set.index === 'number' ? { index: set.index } : {}),
            ...(typeof set.total === 'number' ? { total: set.total } : {}),
          }
        : undefined
      event.message = { id: messageId, type: 'image', contentProvider: { type: 'line' }, ...(imageSet ? { imageSet } : {}) }
      item = { from: 'user', persona: p.key, messageId, message: { type: 'image', url, fileName } }
    } else {
      event.message = { id: messageId, type: 'file', fileName, fileSize: data.byteLength }
      item = { from: 'user', persona: p.key, messageId, message: { type: 'file', url, fileName, size: data.byteLength } }
    }
  } else if (type === 'sticker') {
    event.message = { id: messageId, type: 'sticker', packageId: '446', stickerId: '1988', stickerResourceType: 'STATIC' }
    item = { from: 'user', persona: p.key, messageId, message: { type: 'sticker' } }
  } else {
    return bad(`unknown message type ${String(type)}`)
  }

  // The chat shows the message before the bot answers it.
  world.addChat({ ...item, at: at.toISOString() }, g)
  await deliver(demo, g, [event], `${p.key} sent ${String(type)}${type === 'text' ? ` "${String(b.text).slice(0, 60)}"` : ''}`)
  return ok({ messageId })
}

async function postback(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  if (typeof b.data !== 'string' || b.data === '') return bad('data is required')
  const raw = (typeof b.params === 'object' && b.params !== null ? b.params : {}) as Record<string, unknown>
  const params: { date?: string; time?: string; datetime?: string } = {}
  for (const k of ['date', 'time', 'datetime'] as const) if (typeof raw[k] === 'string') params[k] = raw[k] as string
  const event = base(demo, g, 'postback', p.lineUserId)
  event.postback = Object.keys(params).length ? { data: b.data, params } : { data: b.data }
  await deliver(demo, g, [event], `${p.key} pressed postback "${b.data.slice(0, 60)}"`)
  return ok({})
}

async function unsend(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  if (typeof b.messageId !== 'string') return bad('messageId is required')
  const item = g.chat.find((c) => c.messageId === b.messageId)
  if (!item) return bad(`unknown message ${b.messageId}`, 404)
  item.unsent = true
  const event = base(demo, g, 'unsend', p.lineUserId, false)
  event.unsend = { messageId: b.messageId }
  await deliver(demo, g, [event], `${p.key} unsent ${b.messageId}`)
  return ok({})
}

// ---- group membership ----

function storeRow(demo: Demo, g: DemoGroup) {
  return demo.store.tables.groups.find((r) => r.lineGroupId === g.lineGroupId)
}

async function join(demo: Demo, g: DemoGroup): Promise<SimResult> {
  const { world } = demo
  const row = storeRow(demo, g)
  const setUp = row !== undefined && (row.projectId !== null || row.ownerConfirmedAt !== null)
  g.botInGroup = true
  world.system('NongJoDII เข้าร่วมกลุ่ม', g)
  await deliver(demo, g, [base(demo, g, 'join', null)], 'bot joined the group')
  if (!setUp) learnMembers(demo, g)
  return ok({})
}

/** LINE tells a bot nothing about who is already in a group; the real bot learns a Member
 *  from their first message. So the setup form lists everyone at once, the demo writes each
 *  person in the group as a live Member (LINE name only, no role: roles come from the form)
 *  straight into the store, as the seed does. No chat item, no event. */
function learnMembers(demo: Demo, g: DemoGroup): void {
  const row = storeRow(demo, g)
  if (!row) {
    demo.world.addLog('error', `[${g.name}] join stored no group row: members not learned`)
    return
  }
  const live = new Set(
    demo.store.tables.group_members.filter((m) => m.groupId === row.id && m.leftAt === null).map((m) => m.lineUserId),
  )
  const learned: string[] = []
  for (const p of demo.world.membersInGroup(g)) {
    if (live.has(p.lineUserId)) continue
    seedLiveMember(demo.store, row.id, p, false)
    learned.push(p.lineName)
  }
  if (learned.length) demo.world.addLog('event', `[${g.name}] members learned silently: ${learned.join(', ')}`)
}

async function leaveBot(demo: Demo, g: DemoGroup): Promise<SimResult> {
  const { world } = demo
  if (!g.botInGroup) return bad('the bot is not in the group')
  // LINE sends the leave event to the bot as it is removed.
  const event = base(demo, g, 'leave', null, false)
  await deliver(demo, g, [event], 'bot removed from the group')
  g.botInGroup = false
  world.system('NongJoDII ถูกนำออกจากกลุ่ม', g)
  return ok({})
}

async function memberJoin(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  await joinPersona(demo, g, p)
  return ok({})
}

async function joinPersona(demo: Demo, g: DemoGroup, p: DemoPersona): Promise<void> {
  g.members.add(p.key)
  demo.world.system(`${p.lineName} เข้าร่วมกลุ่ม`, g)
  const event = base(demo, g, 'memberJoined', null)
  event.joined = { members: [{ type: 'user', userId: p.lineUserId }] }
  await deliver(demo, g, [event], `${p.key} joined the group`)
}

async function memberLeave(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  g.members.delete(p.key)
  demo.world.system(`${p.lineName} ออกจากกลุ่ม`, g)
  const event = base(demo, g, 'memberLeft', null, false)
  event.left = { members: [{ type: 'user', userId: p.lineUserId }] }
  await deliver(demo, g, [event], `${p.key} left the group`)
  return ok({})
}

/** POST create-group {name, members, mode, parentGroup?}: a new LINE group with those
 *  people; the bot joins (the setup card, members learned silently). 'new-project' then
 *  waits for the setup form like any new group. 'sub-group' attaches it to the Project of
 *  parentGroup with that Project's Owner as its Owner (one admin per Project), through the
 *  store: no user-facing attach path exists yet. The new group becomes the selected one. */
async function createGroup(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const { world, store } = demo
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return bad('name is required')
  if (name.length > GROUP_NAME_MAX) return bad(`name is longer than ${GROUP_NAME_MAX}`)
  if (!Array.isArray(b.members) || b.members.length === 0 || !b.members.every((k) => typeof k === 'string')) {
    return bad('members must be a non-empty list of persona keys')
  }
  const keys = [...new Set(b.members as string[])]
  for (const k of keys) if (!world.persona(k)) return bad(`unknown persona ${k}`, 404)
  const mode = b.mode
  if (mode !== 'new-project' && mode !== 'sub-group') return bad("mode must be 'new-project' or 'sub-group'")

  let attach: { projectId: string; owner: string } | null = null
  if (mode === 'sub-group') {
    if (typeof b.parentGroup !== 'string') return bad('parentGroup is required for a sub-group')
    const parent = world.groupById(b.parentGroup)
    if (!parent) return bad(`unknown group ${b.parentGroup}`, 404)
    const prow = storeRow(demo, parent)
    if (!prow?.projectId || prow.ownerConfirmedAt === null) return bad(`${parent.name} has no Project with a confirmed Owner yet`)
    const project = store.tables.projects.find((x) => x.id === prow.projectId)
    if (!project) return bad(`${parent.name} has no Project`)
    const owner = world.personaById(project.ownerLineUserId)
    if (!owner || !keys.includes(owner.key)) {
      return bad(`a Sub group's Owner is its Project's Owner (${owner?.lineName ?? project.ownerLineUserId}): add them to members`)
    }
    attach = { projectId: project.id, owner: owner.lineUserId }
  }

  const g = world.addGroup({ name, members: keys })
  world.select(g.lineGroupId)
  world.system(`สร้างกลุ่ม "${name}"`, g)
  await join(demo, g)
  if (attach) {
    const row = storeRow(demo, g)
    if (!row) return bad('the join stored no group row', 500)
    attachSubGroup(store, row.id, attach.projectId, attach.owner, world.now())
    // A Sub group gets no setup form, so its members get their nicknames and role here.
    for (const p of world.membersInGroup(g)) seedLiveMember(store, row.id, p, true)
    world.addLog('event', `[${name}] attached as a Sub group (store write; no user-facing path yet)`)
  }
  return ok({ lineGroupId: g.lineGroupId })
}

// ---- clock, tick, quota ----

/** The next Bangkok 09:00 strictly after `now`; with `isoWeekday`, the next one on that day. */
export function nextBangkok0900(now: Date, isoWeekday?: number): Date {
  const local = now.getTime() + BKK_OFFSET_MS
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS
  for (let i = 0; i <= 8; i++) {
    const target = dayStart + i * DAY_MS + 9 * HOUR_MS
    const wd = ((new Date(target).getUTCDay() + 6) % 7) + 1
    if (target > local && (isoWeekday === undefined || wd === isoWeekday)) return new Date(target - BKK_OFFSET_MS)
  }
  throw new Error('unreachable')
}

async function clock(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const { world } = demo
  const now = world.now()
  const a = b.advance
  let ms: number
  if (a === '1h') ms = HOUR_MS
  else if (a === '1d') ms = DAY_MS
  else if (a === 'next0900') ms = nextBangkok0900(now).getTime() - now.getTime()
  else if (a === 'nextMon0900') ms = nextBangkok0900(now, 1).getTime() - now.getTime()
  else if (typeof a === 'object' && a !== null && typeof (a as { ms?: unknown }).ms === 'number' && (a as { ms: number }).ms >= 0) ms = (a as { ms: number }).ms
  else return bad("advance must be '1h', '1d', 'next0900', 'nextMon0900' or {ms}")
  world.advance(ms)
  world.addLog('tick', `clock moved ${Math.round(ms / 60_000)} min to ${world.now().toISOString()}`)
  if (b.runTick !== false) await runDemoTick(demo)
  return ok({ now: world.now().toISOString() })
}

async function tick(demo: Demo): Promise<SimResult> {
  await runDemoTick(demo)
  return ok({ now: demo.world.now().toISOString() })
}

async function runDemoTick(demo: Demo): Promise<void> {
  const count = () => demo.world.groups.reduce((n, g) => n + g.chat.length, 0)
  const before = count()
  await runTick(demo.deps)
  demo.world.addLog('tick', `tick ran at ${demo.world.now().toISOString()}: ${count() - before} new chat item(s) across ${demo.world.groups.length} group(s)`)
}

function quota(demo: Demo, b: Record<string, unknown>): SimResult {
  const q = demo.world.quota
  if (b.limit !== undefined) {
    if (b.limit !== null && (typeof b.limit !== 'number' || b.limit < 0)) return bad('limit must be a number >= 0 or null')
    q.limit = b.limit as number | null
  }
  if (b.used !== undefined) {
    if (typeof b.used !== 'number' || b.used < 0) return bad('used must be a number >= 0')
    q.used = b.used
  }
  return ok({ quota: { ...q } })
}

// ---- personas ----

function persona(demo: Demo, b: Record<string, unknown>): SimResult {
  if (typeof b.key !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(b.key)) return bad('key must be 1-32 of a-z 0-9 _ -')
  if (typeof b.lineName !== 'string' || b.lineName.trim() === '') return bad('lineName is required')
  const p = upsertPersona(demo, {
    key: b.key, lineName: b.lineName.trim(),
    role: typeof b.role === 'string' ? b.role : b.role === null ? null : undefined,
    owner: typeof b.owner === 'boolean' ? b.owner : undefined,
  })
  return ok({ persona: p })
}

function upsertPersona(
  demo: Demo, p: { key: string; lineName: string; role?: string | null; owner?: boolean },
): DemoPersona {
  const { world } = demo
  const found = world.persona(p.key)
  if (found) {
    found.lineName = p.lineName
    if (p.role !== undefined) found.role = p.role
    if (p.owner !== undefined) found.owner = p.owner
    return found
  }
  let n = world.personas.length + 1
  while (world.personaById(demoUserId(`a${String(n).padStart(2, '0')}`))) n += 1
  const created: DemoPersona = {
    key: p.key, lineUserId: demoUserId(`a${String(n).padStart(2, '0')}`), lineName: p.lineName,
    role: p.role ?? null, owner: p.owner ?? false,
  }
  world.personas.push(created)
  return created
}

// ---- scripts ----

async function listScripts(demo: Demo): Promise<{ scripts: Array<{ name: string; description: string | null; messages: number }> }> {
  const all = await readScripts(scriptsDir, (msg) => demo.world.addLog('error', msg))
  return {
    scripts: all.map(({ name, script: s }) => ({
      name, description: typeof s.description === 'string' ? s.description : null, messages: s.messages.length,
    })),
  }
}

/** Every *.json scenario in `dir`, sorted by file name. A file that is not valid JSON or
 *  has no messages[] is skipped and reported through `onError`. */
export async function readScripts(dir: string, onError: (msg: string) => void): Promise<Array<{ name: string; script: DemoScript }>> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  } catch (err) {
    onError(`scripts: cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const out: Array<{ name: string; script: DemoScript }> = []
  for (const file of files) {
    const name = file.slice(0, -'.json'.length)
    if (!SCRIPT_NAME.test(name)) {
      onError(`script file ${file}: name must be letters, digits, - or _ only`)
      continue
    }
    const script = await readScriptFile(dir, name, onError)
    if (script) out.push({ name, script })
  }
  return out
}

/** One scenario by name (with or without .json); null when the name is not a plain file
 *  name, the file is missing, or it is not a valid script. */
export async function readScript(dir: string, rawName: string, onError: (msg: string) => void): Promise<DemoScript | null> {
  const name = rawName.replace(/\.json$/, '')
  if (!SCRIPT_NAME.test(name)) return null
  return readScriptFile(dir, name, onError)
}

async function readScriptFile(dir: string, name: string, onError: (msg: string) => void): Promise<DemoScript | null> {
  let text: string
  try {
    text = await readFile(path.join(dir, `${name}.json`), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') onError(`script ${name}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    onError(`script ${name}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    return null
  }
  const script = asScript(parsed)
  if (!script) onError(`script ${name}: needs messages[] of {persona, text}`)
  return script
}

function asScript(x: unknown): DemoScript | null {
  if (typeof x !== 'object' || x === null) return null
  const s = x as DemoScript
  if (!Array.isArray(s.messages)) return null
  if (!s.messages.every((m) => typeof m === 'object' && m !== null && typeof m.persona === 'string' && typeof m.text === 'string')) return null
  return s
}

async function loadScript(demo: Demo, g: DemoGroup, b: Record<string, unknown>): Promise<SimResult> {
  let script: DemoScript | null
  if (typeof b.name === 'string') {
    if (!SCRIPT_NAME.test(b.name.replace(/\.json$/, ''))) return bad(`bad script name ${b.name}`)
    script = await readScript(scriptsDir, b.name, (msg) => demo.world.addLog('error', msg))
    if (!script) return bad(`unknown script ${b.name}`, 404)
  } else {
    script = asScript(b.script)
    if (!script) return bad('name or script (with messages[]) is required')
  }
  const delayMs = typeof b.delayMs === 'number' && b.delayMs >= 0 ? Math.min(b.delayMs, 60_000) : 1200
  // A script persona the demo does not know becomes a new persona.
  for (const [key, sp] of Object.entries(script.personas ?? {})) {
    if (!demo.world.persona(key)) upsertPersona(demo, { key, lineName: sp.lineName, role: sp.role, owner: sp.owner })
  }
  const steps = [...script.messages, ...(script.summaryCommand ? [script.summaryCommand] : [])]
  for (const s of steps) if (!demo.world.persona(s.persona)) return bad(`script uses unknown persona ${s.persona}`)
  // Every speaker must be in the target group: one who is not joins it first (memberJoined).
  const outsiders = [...new Set(steps.map((s) => s.persona))].filter((k) => !g.members.has(k))

  const name = script.name ?? 'script'
  demo.world.addLog('event', `[${g.name}] script ${name}: playing ${steps.length} message(s), one per ${delayMs} ms`)
  // The group is fixed now: switching groups on the phone does not move a playing script.
  demo.defer(async () => {
    for (const key of outsiders) {
      if (getDemo().generation !== demo.generation) return
      const p = demo.world.persona(key) as DemoPersona
      await joinPersona(demo, g, p)
      // As if they filled in "ข้อมูลของฉัน" from the welcome card: nicknames and role, so
      // the Summary knows "บอม" is Bomb in this group too.
      const row = storeRow(demo, g)
      if (row) seedLiveMember(demo.store, row.id, p, true)
    }
    for (const s of steps) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      // A reset stops the player.
      if (getDemo().generation !== demo.generation) return
      const res = await send(demo, g, { persona: s.persona, type: 'text', text: s.text })
      if (res.status !== 200) demo.world.addLog('error', `script ${name}: ${JSON.stringify(res.body)}`)
    }
    demo.world.addLog('event', `[${g.name}] script ${name}: done`)
  })
  return ok({ steps: steps.length, delayMs, group: g.lineGroupId, joined: [...outsiders] })
}
