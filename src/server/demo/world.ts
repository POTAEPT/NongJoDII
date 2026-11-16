import { randomUUID } from 'node:crypto'
import type { ChatItem, ChatMessage, DemoPersona, LogEntry, LogKind } from './types'

export const DEMO_LIFF_ID = 'demo-liff'
export const DEMO_GROUP_ID = 'Cdemo0000000000000000000000000001'
export const DEMO_GROUP_NAME = 'ทีมพิตช์ NongJoDII'
export const DEMO_WORK_DESCRIPTION = 'เตรียมงานพิตช์รอบสุดท้ายของทีม NongJoDII'
export const DEMO_TOKEN_PREFIX = 'demo:'
export const DEFAULT_QUOTA_LIMIT = 500
const LOG_MAX = 200

/** 'Udemo' + zeros + suffix, 33 characters like a LINE user ID. */
export function demoUserId(suffix: string): string {
  return `Udemo${suffix.padStart(28, '0')}`
}

/** 'Cdemo' + zeros + n, 33 characters like a LINE group ID. */
export function demoGroupId(n: number): string {
  return `Cdemo${String(n).padStart(28, '0')}`
}

export function seedPersonas(): DemoPersona[] {
  return [
    { key: 'nont', lineUserId: demoUserId('a01'), lineName: 'Nont', role: 'manager', owner: true, nicknames: ['นนท์'] },
    { key: 'tae', lineUserId: demoUserId('a02'), lineName: 'Tae', role: 'developer', owner: false, nicknames: ['เต้'] },
    { key: 'bomb', lineUserId: demoUserId('a03'), lineName: 'Bomb', role: 'designer', owner: false, nicknames: ['บอม'] },
    { key: 'jeff', lineUserId: demoUserId('a04'), lineName: 'Jeff', role: 'marketing', owner: false, nicknames: ['เจฟ'] },
  ]
}

/** One LINE group as LINE sees it: its name, who is in it (persona keys), whether the bot
 *  is, and its chat. readCount: chat items the presenter has seen; the rest are unread. */
export type DemoGroup = {
  lineGroupId: string
  name: string
  botInGroup: boolean
  members: Set<string>
  chat: ChatItem[]
  readCount: number
}

/** Everything the simulator shows besides the store: the clock, the LINE groups as LINE
 *  sees them, their chats, the event log and the uploaded bytes. One per reset. */
export class DemoWorld {
  /** Demo time = real time + offset, so the clock keeps moving between clicks. */
  private offsetMs = 0
  private lastEventMs = 0
  private seq = 0
  private groupSeq = 1
  personas: DemoPersona[] = seedPersonas()
  groups: DemoGroup[] = []
  selectedGroupId: string
  /** Reply token -> the LINE group whose event carried it (DemoLine replies into that chat). */
  replyTokens = new Map<string, string>()
  quota: { limit: number | null; used: number } = { limit: DEFAULT_QUOTA_LIMIT, used: 0 }
  log: LogEntry[] = []
  /** LINE message id -> uploaded bytes (images and files the presenter sent). */
  contents = new Map<string, { data: Uint8Array; contentType: string | null; fileName: string }>()

  constructor(offsetMs = 0) {
    this.offsetMs = offsetMs
    // The default group: the four personas, the bot not in it yet.
    const g = this.addGroup({ lineGroupId: DEMO_GROUP_ID, name: DEMO_GROUP_NAME, members: this.personas.map((p) => p.key) })
    this.selectedGroupId = g.lineGroupId
  }

  now = (): Date => new Date(Date.now() + this.offsetMs)
  get clockOffsetMs(): number {
    return this.offsetMs
  }
  advance(ms: number): void {
    this.offsetMs += Math.max(0, ms)
  }
  setNow(d: Date): void {
    this.offsetMs = d.getTime() - Date.now()
  }

  /** A webhook event time: the demo clock, strictly after the previous event, so two
   *  messages never share a sentAt (a Summary's "since last" check is strict). */
  eventTime(): number {
    const t = Math.max(this.now().getTime(), this.lastEventMs + 1)
    this.lastEventMs = t
    return t
  }

  nextId(prefix: string): string {
    this.seq += 1
    return `${prefix}${Date.now().toString(36)}${this.seq}`
  }

  // ---- groups ----

  addGroup(g: { lineGroupId?: string; name: string; members: string[]; botInGroup?: boolean }): DemoGroup {
    let id = g.lineGroupId
    while (!id || this.groupById(id)) {
      this.groupSeq += 1
      id = demoGroupId(this.groupSeq)
    }
    const group: DemoGroup = {
      lineGroupId: id, name: g.name, botInGroup: g.botInGroup ?? false, members: new Set(g.members), chat: [], readCount: 0,
    }
    this.groups.push(group)
    return group
  }
  groupById(lineGroupId: string): DemoGroup | undefined {
    return this.groups.find((g) => g.lineGroupId === lineGroupId)
  }
  /** The selected group (the one the phone shows). */
  get group(): DemoGroup {
    return this.groupById(this.selectedGroupId) ?? this.groups[0]
  }
  /** The selected group's chat. */
  get chat(): ChatItem[] {
    return this.group.chat
  }
  /** Opens a group on the phone: it becomes the default target and its chat is read. */
  select(lineGroupId: string): boolean {
    const g = this.groupById(lineGroupId)
    if (!g) return false
    this.selectedGroupId = g.lineGroupId
    g.readCount = g.chat.length
    return true
  }
  unread(group: DemoGroup): number {
    if (group.lineGroupId === this.selectedGroupId) return 0
    return group.chat.slice(group.readCount).filter((c) => c.from !== 'system').length
  }

  persona(key: string): DemoPersona | undefined {
    return this.personas.find((p) => p.key === key)
  }
  personaById(lineUserId: string): DemoPersona | undefined {
    return this.personas.find((p) => p.lineUserId === lineUserId)
  }
  membersInGroup(group: DemoGroup = this.group): DemoPersona[] {
    return this.personas.filter((p) => group.members.has(p.key))
  }

  /** A chat item in `group` (default: the selected one). */
  addChat(item: Omit<ChatItem, 'id' | 'at'> & { at?: string }, group: DemoGroup = this.group): ChatItem {
    const full: ChatItem = { id: randomUUID(), at: item.at ?? this.now().toISOString(), ...item }
    group.chat.push(full)
    // The open group is read as it changes.
    if (group.lineGroupId === this.selectedGroupId) group.readCount = group.chat.length
    return full
  }
  system(text: string, group: DemoGroup = this.group): ChatItem {
    const message: ChatMessage = { type: 'system', text }
    return this.addChat({ from: 'system', message }, group)
  }

  addLog(kind: LogKind, summary: string): void {
    this.log.push({ at: this.now().toISOString(), kind, summary: summary.slice(0, 500) })
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX)
  }
}
