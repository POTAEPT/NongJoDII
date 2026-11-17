import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LineEvent, LineMention } from '@/server/line/types'
import { runTick } from '@/server/tick/run-tick'
import { ownerInsightKey } from '@/server/insight/owner'
import {
  BKK_OFFSET_MS, bangkokIsoWeekday, bangkokTodayLabel, bangkokWeekStartLabel, isWeeklyDue, parseTimeOfDay,
} from '@/server/time/bangkok'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { getDemo, resetDemo, seedLiveMember, type Demo } from './demo-deps'
import { deleteGroupFile, fileStem, groupsDir, readGroupFiles, writeGroupFile, type GroupFile } from './group-files'
import { recordSetUpFiles } from './setup-files'
import { signedWebhookRequest } from './sign'
import type { ChatItem, DemoDirectInfo, DemoGroupInfo, DemoPersona, DemoScript, DemoScriptMessage, DemoState } from './types'
import { DEMO_LIFF_ID, demoGroupId, demoUserId, type DemoGroup } from './world'

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

/** Every sim route. GET: state, scripts. POST: the rest. After a POST, a group whose setup
 *  just completed gets it recorded in its file (setup-files.ts). */
export async function runSimAction(action: string, method: string, body: unknown): Promise<SimResult> {
  const result = await runAction(action, method, body)
  if (method === 'POST') recordSetUpFiles(getDemo())
  return result
}

async function runAction(action: string, method: string, body: unknown): Promise<SimResult> {
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
  if (action === 'delete-group') return deleteGroup(demo, b)
  if (action === 'clock') return clock(demo, b)
  if (action === 'tick') return tick(demo)
  if (action === 'quota') return quota(demo, b)
  if (action === 'persona') return persona(demo, b)
  // 1:1 chat with the bot (the user is the event source; no group involved).
  if (action === 'open-direct') return openDirect(demo, b)
  if (action === 'follow') return follow(demo, b)
  if ((action === 'send' || action === 'message') && b.direct === true) return sendDirect(demo, b)
  if (action === 'postback' && b.direct === true) return postbackDirect(demo, b)
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
    case 'say-hi': return sayHi(demo, g)
    case 'leave-bot': return leaveBot(demo, g)
    case 'member-join': return memberJoin(demo, g, b)
    case 'member-leave': return memberLeave(demo, g, b)
    case 'load-script': return await loadScript(demo, g, b)
    case 'weekly': return await weekly(demo, g)
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
    directChats: world.personas.map((p) => directInfo(demo, p.key)),
    openDirect: world.openDirect,
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
    file: g.file,
    unknownMembers: unknownMembers(demo, g).map((p) => p.key),
  }
}

/** The group's people the bot holds no live Member for: it learns a person only from their
 *  first message (#151). */
function unknownMembers(demo: Demo, g: DemoGroup): DemoPersona[] {
  const row = storeRow(demo, g)
  const live = new Set(row
    ? demo.store.tables.group_members.filter((m) => m.groupId === row.id && m.leftAt === null).map((m) => m.lineUserId)
    : [])
  return demo.world.membersInGroup(g).filter((p) => !live.has(p.lineUserId))
}

function directInfo(demo: Demo, personaKey: string): DemoDirectInfo {
  const last = demo.world.direct.get(personaKey)?.at(-1)
  return {
    persona: personaKey,
    lastMessage: last ? { text: preview(demo, last, false), at: last.at } : null,
    unread: demo.world.directUnread(personaKey),
  }
}

/** The chat list's one-line preview, LINE style ("Nont: ..."); a 1:1 chat shows no name. */
function preview(demo: Demo, c: ChatItem, withName = true): string {
  const m = c.message
  let text: string
  if (m.type === 'text') text = m.text
  else if (m.type === 'image') text = '[รูปภาพ]'
  else if (m.type === 'file') text = `[ไฟล์] ${m.fileName}`
  else if (m.type === 'sticker') text = '[สติกเกอร์]'
  else if (m.type === 'system') return m.text
  else text = m.altText
  if (c.unsent) text = 'ยกเลิกข้อความแล้ว'
  if (!withName) return text
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

// ---- 1:1 chat with the bot (#84 Rich Menu, #120 Owner card) ----

/** An event from the person's 1:1 chat with the OA: source {type:'user'}. Its reply token
 *  maps to the persona, so DemoLine answers into that 1:1 thread, never into a group. */
function directBase(demo: Demo, p: DemoPersona, type: string, withReply = true): LineEvent {
  const { world } = demo
  const replyToken = withReply ? world.nextId('rt') : null
  if (replyToken) world.directReplyTokens.set(replyToken, p.key)
  return {
    type,
    mode: 'active',
    timestamp: world.eventTime(),
    source: { type: 'user', userId: p.lineUserId },
    ...(replyToken ? { replyToken } : {}),
    webhookEventId: world.nextId('ev'),
    deliveryContext: { isRedelivery: false },
  }
}

/** A 1:1 event always reaches the bot (the persona is a friend of the OA). */
async function deliverDirect(demo: Demo, p: DemoPersona, events: LineEvent[], label: string): Promise<void> {
  const where = `[1:1 ${p.lineName}] ${label}`
  demo.world.addLog('event', where)
  const res = await handleWebhookRequest(signedWebhookRequest(events, demo.deps.config.lineChannelSecret), demo.deps, demo.defer)
  if (res.status !== 200) demo.world.addLog('error', `${where}: webhook answered ${res.status}`)
}

/** POST send {persona, type:'text', text, direct:true}: a text the person types (or a Rich
 *  Menu tile sends) in their 1:1 chat. Only text: the menu handler reads nothing else. */
async function sendDirect(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  if ((b.type ?? 'text') !== 'text') return bad('a 1:1 message must be text')
  if (typeof b.text !== 'string' || b.text.trim() === '') return bad('text is required')
  const { world } = demo
  const messageId = world.nextId('')
  const event = directBase(demo, p, 'message')
  event.message = { id: messageId, type: 'text', text: b.text }
  world.addDirect(p.key, { at: new Date(event.timestamp).toISOString(), from: 'user', persona: p.key, messageId, message: { type: 'text', text: b.text } })
  await deliverDirect(demo, p, [event], `${p.key} sent "${b.text.slice(0, 60)}"`)
  return ok({ messageId })
}

/** POST postback {persona, data, params?, direct:true}: a button pressed in the 1:1 chat.
 *  The bot records 1:1 postbacks and answers none. */
async function postbackDirect(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  if (typeof b.data !== 'string' || b.data === '') return bad('data is required')
  const event = directBase(demo, p, 'postback')
  event.postback = { data: b.data }
  await deliverDirect(demo, p, [event], `${p.key} pressed postback "${b.data.slice(0, 60)}"`)
  return ok({})
}

/** POST follow {persona}: the person adds the OA as a friend; the bot answers with the
 *  Google Drive card, as in LINE. */
async function follow(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  demo.world.addDirect(p.key, { from: 'system', message: { type: 'system', text: `${p.lineName} เพิ่ม NongJoDII เป็นเพื่อน` } })
  await deliverDirect(demo, p, [directBase(demo, p, 'follow')], `${p.key} followed the OA`)
  return ok({})
}

/** POST open-direct {persona | null}: the phone shows that persona's 1:1 chat (its unread
 *  goes to 0) or, with null, no 1:1 chat. The selected group stays selected. */
function openDirect(demo: Demo, b: Record<string, unknown>): SimResult {
  if (b.persona === null) {
    demo.world.openDirectChat(null)
    return ok({ openDirect: null })
  }
  const p = personaOf(demo, b.persona)
  if (isResult(p)) return p
  demo.world.openDirectChat(p.key)
  return ok({ openDirect: p.key })
}

// ---- group membership ----

function storeRow(demo: Demo, g: DemoGroup) {
  return demo.store.tables.groups.find((r) => r.lineGroupId === g.lineGroupId)
}

async function join(demo: Demo, g: DemoGroup): Promise<SimResult> {
  g.botInGroup = true
  demo.world.system('NongJoDII เข้าร่วมกลุ่ม', g)
  // As in LINE, the bot learns no one on join: its setup card asks everyone to say hi (#151).
  await deliver(demo, g, [base(demo, g, 'join', null)], 'bot joined the group')
  return ok({})
}

/** Short, different greetings, one per person, as a group would answer the bot's ask. */
const GREETINGS = ['สวัสดีครับ 👋', 'หวัดดีค่ะทุกคน', 'ดีจ้า', 'สวัสดีน้องจดดี', 'มาแล้วครับ', 'หวัดดีครับผม', 'ทักทายค่ะ 🙌', 'สวัสดีจ้า']

/** POST say-hi {group?}: every person in the group the bot does not know yet sends one
 *  greeting through the webhook, so the bot learns them as it would in LINE. */
async function sayHi(demo: Demo, g: DemoGroup): Promise<SimResult> {
  if (!g.botInGroup) return bad('the bot is not in the group')
  const people = unknownMembers(demo, g)
  for (const [i, p] of people.entries()) {
    const res = await send(demo, g, { persona: p.key, text: GREETINGS[i % GREETINGS.length] })
    if (res.status !== 200) return res
  }
  return ok({ greeted: people.map((p) => p.key) })
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

/** POST create-group {name, members}: a new LINE group with those people, and the bot joins
 *  it: its setup card, no known Member. New Project or Sub group is picked in the real setup
 *  form (#159), as in LINE. The group is saved as a not-set-up file and becomes the selected
 *  one. */
async function createGroup(demo: Demo, b: Record<string, unknown>): Promise<SimResult> {
  const { world } = demo
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name) return bad('name is required')
  if (name.length > GROUP_NAME_MAX) return bad(`name is longer than ${GROUP_NAME_MAX}`)
  if (!Array.isArray(b.members) || b.members.length === 0 || !b.members.every((k) => typeof k === 'string')) {
    return bad('members must be a non-empty list of persona keys')
  }
  if (b.mode === 'sub-group') return bad('a Sub group is attached in the setup form: create the group, then open the bot\'s setup card')
  const keys = [...new Set(b.members as string[])]
  for (const k of keys) if (!world.persona(k)) return bad(`unknown persona ${k}`, 404)

  const dir = groupsDir()
  const onError = (msg: string) => world.addLog('error', msg)
  const files = readGroupFiles(dir, onError).entries
  // Never an id a group file holds, so the group's file does not clash at the next reset.
  const taken = new Set([...world.groups.map((x) => x.lineGroupId), ...files.map((f) => f.def.lineGroupId)])
  let n = 1
  while (taken.has(demoGroupId(n))) n += 1
  const g = world.addGroup({ lineGroupId: demoGroupId(n), name, members: keys })
  world.select(g.lineGroupId)
  world.system(`สร้างกลุ่ม "${name}"`, g)
  await join(demo, g)
  g.file = saveGroupFile(demo, dir, g, keys)
  g.fileNotSetUp = g.file !== null
  return ok({ lineGroupId: g.lineGroupId, file: g.file })
}

/** Writes the new group's file as not set up (no Tasks, no chat): every Reset and server
 *  start brings it back with the bot's setup card, until its setup completes and
 *  setup-files.ts records the outcome. null: not saved (logged). */
function saveGroupFile(demo: Demo, dir: string, g: DemoGroup, keys: string[]): string | null {
  const { world } = demo
  const def: GroupFile = { name: g.name, lineGroupId: g.lineGroupId, members: keys, setUp: false }
  try {
    const file = writeGroupFile(dir, def)
    world.addLog('event', `[${g.name}] saved as ${file} (not set up): it comes back after every Reset`)
    return file
  } catch (err) {
    world.addLog('error', `[${g.name}] not saved as a file: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** POST delete-group {group}: deletes the group's file and takes the group out of the
 *  world and the store. Refused while another file names it as its parent, and for the
 *  only group (the phone always shows one). */
function deleteGroup(demo: Demo, b: Record<string, unknown>): SimResult {
  const { world } = demo
  if (typeof b.group !== 'string' || b.group === '') return bad('group (a lineGroupId) is required')
  const g = world.groupById(b.group)
  if (!g) return bad(`unknown group ${b.group}`, 404)
  if (world.groups.length <= 1) return bad('cannot delete the only group')
  const dir = groupsDir()
  if (g.file) {
    const own = fileStem(g.file)
    const children = readGroupFiles(dir, (msg) => world.addLog('error', msg)).entries
      .filter((e) => e.def.mode === 'sub-group' && fileStem(e.def.parent ?? '') === own)
      .map((e) => `${e.def.name} (${e.file})`)
    if (children.length) return bad(`${g.name} is the parent of ${children.join(', ')}: delete the Sub group first`)
    try {
      deleteGroupFile(dir, g.file)
    } catch (err) {
      return bad(`cannot delete ${g.file}: ${err instanceof Error ? err.message : String(err)}`, 500)
    }
  }
  removeFromStore(demo, g)
  world.removeGroup(g.lineGroupId)
  world.addLog('event', `[${g.name}] deleted${g.file ? ` with ${g.file}` : ''}`)
  return ok({ deleted: g.lineGroupId, file: g.file, selectedGroup: world.selectedGroupId })
}

/** Every store row of the group (any table's rows with its groupId), the group row, and its
 *  Project when no other group is in it, so the Dashboard no longer lists it. */
function removeFromStore(demo: Demo, g: DemoGroup): void {
  const { tables } = demo.store
  const row = storeRow(demo, g)
  if (!row) return
  for (const rows of Object.values(tables) as Array<Array<Record<string, unknown>>>) {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].groupId === row.id) rows.splice(i, 1)
  }
  tables.groups.splice(tables.groups.indexOf(row), 1)
  if (row.projectId && !tables.groups.some((r) => r.projectId === row.projectId)) {
    const p = tables.projects.findIndex((x) => x.id === row.projectId)
    if (p !== -1) tables.projects.splice(p, 1)
  }
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

// ---- weekly (#21 group card, #120 Owner card) ----

export type WeeklySlot = { weekday: number; time: string; lastSentOn: string | null }

/** A group's weekly slot as the store holds it; no schedule row = the schema defaults
 *  (Monday 09:00, never sent). null: the weekly summary is off or the bot left. */
function weeklySlotOf(demo: Demo, groupId: string): WeeklySlot | null {
  const s = demo.store.tables.group_schedules.find((r) => r.groupId === groupId)
  if (!s) return { weekday: 1, time: '09:00:00', lastSentOn: null }
  if (!s.featureWeeklySummary || s.leftAt !== null) return null
  return { weekday: s.weeklySummaryWeekday, time: s.weeklySummaryTime, lastSentOn: s.weeklySummaryLastSentOn }
}

/** This week's run already happened for the main group: its weekly insight row, or the
 *  Owner card's ledger row (owner_insight:<projectId>:<weekStart>, once per Project per week). */
function weeklyRan(demo: Demo, mainGroupId: string, projectId: string, weekStart: string): boolean {
  const { tables } = demo.store
  return tables.weekly_insights.some((w) => w.groupId === mainGroupId && w.weekStart === weekStart)
    || tables.webhook_events.some((e) => e.webhookEventId === ownerInsightKey(projectId, weekStart))
}

/** When a tick next sends the weekly post (and, for a main group, the Owner card): `now`
 *  when the slot is reached today and this week has not run; else the first slot strictly
 *  after now whose week has not run. null: none in the next four weeks. */
export function nextWeeklyFire(now: Date, slot: WeeklySlot, ran: (weekStart: string) => boolean): Date | null {
  if (isWeeklyDue(slot, now) && !ran(bangkokWeekStartLabel(now))) return now
  const minutes = parseTimeOfDay(slot.time)
  const dayStart = Math.floor((now.getTime() + BKK_OFFSET_MS) / DAY_MS) * DAY_MS
  for (let i = 0; i <= 28; i++) {
    const at = new Date(dayStart + i * DAY_MS + minutes * 60_000 - BKK_OFFSET_MS)
    if (at.getTime() <= now.getTime() || bangkokIsoWeekday(at) !== slot.weekday) continue
    if (slot.lastSentOn !== null && slot.lastSentOn >= bangkokTodayLabel(at)) continue
    if (!ran(bangkokWeekStartLabel(at))) return at
  }
  return null
}

/** POST weekly {group?}: moves the clock to the next weekly slot of the group's Project
 *  main group (a group with no Project: the main group whose slot comes first), then runs
 *  the tick, so that main group posts its weekly card (#21) and the Project's Owner gets the
 *  per-person card in their 1:1 chat (#120). Every other group whose slot the new time
 *  reaches posts too, as on a real tick. A week that already ran is skipped, so a second
 *  call gives the next week's card. */
async function weekly(demo: Demo, g: DemoGroup): Promise<SimResult> {
  const { store, world } = demo
  const mains = store.tables.groups.filter((r) => r.projectId !== null && r.ownerConfirmedAt !== null && isMainRow(demo, r.id))
  if (mains.length === 0) return bad('no Project main group with a confirmed Owner yet')
  const now = world.now()
  const own = storeRow(demo, g)?.projectId
  const pool = own ? mains.filter((r) => r.projectId === own) : mains
  const plans = pool
    .map((row) => {
      const slot = weeklySlotOf(demo, row.id)
      const at = slot ? nextWeeklyFire(now, slot, (ws) => weeklyRan(demo, row.id, row.projectId as string, ws)) : null
      return { row, at }
    })
    .filter((x): x is { row: typeof x.row; at: Date } => x.at !== null)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const target = plans[0]
  if (!target) return bad('the main group has no weekly slot to reach (weekly summary off?)')
  const project = store.tables.projects.find((x) => x.id === target.row.projectId)
  const owner = project ? world.personaById(project.ownerLineUserId) : undefined
  const before = owner ? world.direct.get(owner.key)?.length ?? 0 : 0
  if (target.at.getTime() > now.getTime()) world.setNow(target.at)
  world.addLog('tick', `weekly: clock moved to ${world.now().toISOString()}, the weekly slot of ${target.row.name ?? target.row.lineGroupId}`)
  await runDemoTick(demo)
  const after = owner ? world.direct.get(owner.key)?.length ?? 0 : 0
  return ok({
    now: world.now().toISOString(), group: target.row.lineGroupId, owner: owner?.key ?? null, ownerCards: after - before,
  })
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
  const ids = new Set<string>()
  for (const m of s.messages) {
    if (!isScriptMessage(m, ids)) return null
    if (typeof m.id === 'string') ids.add(m.id)
  }
  return s
}

/** The files a scenario can send: public/demo/files/<plain name>. */
const DEFAULT_SCRIPT_FILES_DIR = path.join(process.cwd(), 'public', 'demo', 'files')
let scriptFilesDir = DEFAULT_SCRIPT_FILES_DIR
/** Tests point it at a temp folder; no argument restores the default. */
export function setScriptFilesDir(dir?: string): void {
  scriptFilesDir = dir ?? DEFAULT_SCRIPT_FILES_DIR
}
const SCRIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.txt': 'text/plain', '.csv': 'text/csv',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** A text line needs text; an image or file needs a plain file name (no folders, no ..); a
 *  replyTo must name an earlier message's id. */
function isScriptMessage(m: unknown, earlier: Set<string>): m is DemoScriptMessage {
  if (typeof m !== 'object' || m === null) return false
  const x = m as DemoScriptMessage
  if (typeof x.persona !== 'string') return false
  if (x.replyTo !== undefined && (typeof x.replyTo !== 'string' || !earlier.has(x.replyTo))) return false
  const type = x.type ?? 'text'
  if (type === 'text') return typeof x.text === 'string'
  if (type !== 'image' && type !== 'file') return false
  if (x.fileName !== undefined && typeof x.fileName !== 'string') return false
  return typeof x.file === 'string' && SCRIPT_FILE.test(x.file) && !x.file.includes('..')
}

/** The bytes of a scenario's file, as POST send takes them; null when it cannot be read. */
async function scriptFile(m: DemoScriptMessage): Promise<{ fileName: string; contentType: string; dataBase64: string } | null> {
  try {
    const data = await readFile(path.join(scriptFilesDir, m.file as string))
    const ext = path.extname(m.file as string).toLowerCase()
    return {
      fileName: m.fileName || (m.file as string),
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
      dataBase64: data.toString('base64'),
    }
  } catch {
    return null
  }
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
  const steps: DemoScriptMessage[] = [...script.messages, ...(script.summaryCommand ? [script.summaryCommand] : [])]
  for (const s of steps) if (!demo.world.persona(s.persona)) return bad(`script uses unknown persona ${s.persona}`)
  // Every file is read before anything plays, so a missing one never cuts a scene halfway.
  const files = new Map<DemoScriptMessage, NonNullable<Awaited<ReturnType<typeof scriptFile>>>>()
  for (const s of steps) {
    if ((s.type ?? 'text') === 'text') continue
    const f = await scriptFile(s)
    if (!f) return bad(`script file public/demo/files/${s.file} cannot be read`)
    files.set(s, f)
  }
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
    // A script id -> the LINE message id it got, for replyTo.
    const sent = new Map<string, string>()
    for (const s of steps) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      // A reset stops the player.
      if (getDemo().generation !== demo.generation) return
      const quoted = s.replyTo ? sent.get(s.replyTo) : undefined
      const file = files.get(s)
      const res = await send(demo, g, file
        ? { persona: s.persona, type: s.type, ...file }
        : { persona: s.persona, type: 'text', text: s.text, ...(quoted ? { quotedMessageId: quoted } : {}) })
      if (res.status !== 200) demo.world.addLog('error', `script ${name}: ${JSON.stringify(res.body)}`)
      else if (s.id) sent.set(s.id, (res.body as { messageId: string }).messageId)
    }
    demo.world.addLog('event', `[${g.name}] script ${name}: done`)
  })
  return ok({ steps: steps.length, delayMs, group: g.lineGroupId, joined: [...outsiders] })
}
