// Typed client for the /demo sim API (docs/demo-contract.md). JSON in and out; an error
// answer is {error} with 400 or 404 and throws a DemoApiError.
import type { AiCall, ChatItem, DemoGroupInfo, DemoScript, DemoState } from '@/server/demo/types'

export type { AiCall, ChatItem, DemoGroupInfo, DemoScript, DemoState }
export type Persona = DemoState['personas'][number]
export type LogEntry = DemoState['log'][number]

const BASE = '/demo/api/sim'

export class DemoApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json ? String((json as { error: unknown }).error) : `HTTP ${res.status}`
    throw new DemoApiError(res.status, msg)
  }
  return json as T
}

export type PostbackParams = { date?: string; time?: string; datetime?: string }
export type ClockAdvance = '1h' | '1d' | 'next0900' | 'nextMon0900' | { ms: number }
export type ScriptInfo = { name: string; description: string; messages: number }
export type ImageSet = { id: string; index: number; total: number }

export const demoApi = {
  state: () => call<DemoState>('state'),
  sendText: (persona: string, text: string, opts: { quotedMessageId?: string; mentions?: string[] } = {}) =>
    call<{ messageId: string }>('send', { persona, type: 'text', text, ...opts }),
  sendImage: (persona: string, file: { fileName: string; contentType: string; dataBase64: string }, imageSet?: ImageSet) =>
    call<{ messageId: string }>('send', { persona, type: 'image', ...file, ...(imageSet ? { imageSet } : {}) }),
  sendFile: (persona: string, file: { fileName: string; contentType: string; dataBase64: string }) =>
    call<{ messageId: string }>('send', { persona, type: 'file', ...file }),
  sendSticker: (persona: string) => call<{ messageId: string }>('send', { persona, type: 'sticker' }),
  postback: (persona: string, data: string, params?: PostbackParams) =>
    call<unknown>('postback', { persona, data, ...(params ? { params } : {}) }),
  unsend: (persona: string, messageId: string) => call<unknown>('unsend', { persona, messageId }),
  join: () => call<unknown>('join', {}),
  leaveBot: () => call<unknown>('leave-bot', {}),
  memberJoin: (persona: string) => call<unknown>('member-join', { persona }),
  memberLeave: (persona: string) => call<unknown>('member-leave', { persona }),
  clock: (advance: ClockAdvance, runTick = true) => call<unknown>('clock', { advance, runTick }),
  tick: () => call<unknown>('tick', {}),
  quota: (q: { limit?: number | null; used?: number }) => call<unknown>('quota', q),
  persona: (p: { key: string; lineName: string; role?: string | null; owner?: boolean }) => call<unknown>('persona', p),
  /** setup true (default): three set-up groups, Nont the Owner, the bot in each. false: one
   *  fresh group for onboarding. */
  reset: (setup = true) => call<unknown>('reset', { setup }),
  scripts: () => call<{ scripts: ScriptInfo[] }>('scripts'),
  /** Plays into `group` (a lineGroupId); missing = the selected group. */
  loadScript: (name: string, opts: { delayMs?: number; group?: string } = {}) =>
    call<unknown>('load-script', { name, ...opts }),
  selectGroup: (group: string) => call<{ selectedGroup: string }>('select-group', { group }),
  createGroup: (g: { name: string; members: string[]; mode: 'new-project' | 'sub-group'; parentGroup?: string }) =>
    call<{ lineGroupId: string }>('create-group', g),
}

/** Base64 of a File's bytes, without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}
