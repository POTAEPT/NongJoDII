import type { LineMessage } from '@/server/line/types'

// The /demo simulator's shared shapes (docs/demo-contract.md). The UI reads these through
// GET /demo/api/sim/state; it may import the types from here (type-only imports).

export type DemoPersona = {
  key: string; lineUserId: string; lineName: string; role: string | null; owner: boolean
  /** Names the bot's AI may know the person by; seeded into the store as nicknames. */
  nicknames?: string[]
}

export type ChatMessage =
  | { type: 'text'; text: string; quotedMessageId?: string }
  | { type: 'image'; url: string; fileName: string }
  | { type: 'file'; url: string; fileName: string; size: number }
  | { type: 'sticker' }
  | { type: 'system'; text: string }
  | LineMessage

export type ChatItem = {
  id: string
  at: string
  from: 'user' | 'bot' | 'system'
  persona?: string
  messageId?: string
  unsent?: boolean
  via?: 'reply' | 'push'
  message: ChatMessage
}

export type LogKind = 'event' | 'reply' | 'push' | 'error' | 'tick'
export type LogEntry = { at: string; kind: LogKind; summary: string }

/** One row of the phone's chat list. lastMessage: a one-line preview of the newest item.
 *  unread: items after the presenter last opened the group (0 for the selected one). */
export type DemoGroupInfo = {
  lineGroupId: string; name: string; botInGroup: boolean
  projectName: string | null; isSubGroup: boolean
  members: number
  lastMessage: { text: string; at: string } | null
  unread: number
}

/** One finished call of the demo AI. costUsd null: neither reported nor priceable ("n/a").
 *  estimated: costUsd was computed from the tokens, not reported by OpenRouter. */
export type AiCallKind = 'summary' | 'progress' | 'tags' | 'other'
export type AiCall = {
  id: string; at: string; kind: AiCallKind; model: string
  inputTokens: number; outputTokens: number; costUsd: number | null; estimated: boolean; fallback: boolean
}

export type DemoState = {
  now: string
  liffId: 'demo-liff'
  /** The selected group (kept for compatibility; same as groups[selectedGroup]). */
  group: { lineGroupId: string; name: string; botInGroup: boolean }
  groups: DemoGroupInfo[]
  selectedGroup: string
  /** inGroup: in the selected group. */
  personas: Array<{ key: string; lineUserId: string; lineName: string; role: string | null; owner: boolean; inGroup: boolean }>
  quota: { limit: number | null; used: number }
  ai: { model: string | null; lastCallFallback: boolean; busy: boolean; calls: AiCall[]; totalUsd: number }
  google: { connected: boolean; email: string | null }
  chat: ChatItem[]
  /** The bot's 1:1 chats, per persona key (for example the Owner's weekly card, #120). */
  direct: Record<string, ChatItem[]>
  log: LogEntry[]
}

/** A script in the e2e scenario shape (e2e/scenario-types.ts). The player uses personas,
 *  messages (in order) and summaryCommand; the other fields are kept for reference. */
export type DemoScript = {
  name: string
  description?: string
  feature?: string
  group?: { lineGroupId?: string; name?: string; workDescription?: string }
  personas?: Record<string, { lineName: string; role: string | null; owner?: boolean; lineUserId?: string }>
  messages: Array<{ id?: string; persona: string; minute?: number; text: string }>
  summaryCommand?: { persona: string; minute?: number; text: string } | null
  [k: string]: unknown
}
