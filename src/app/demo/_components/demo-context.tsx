'use client'

import { createContext, useContext } from 'react'
import type { DemoState, Persona, PostbackParams } from '../_lib/api'

export const DEMO_LIFF_PREFIX = 'https://liff.line.me/demo-liff'

export type LiffTarget = { view: string; id: string | null }

/** A postback's displayText, shown as the presser's bubble right away (LINE shows it
 *  locally; the bot only gets the postback). Dropped once the server's chat has it. */
export type LocalEcho = { id: string; persona: string; text: string; at: string }

export type FlexActionLike = {
  type: string; label?: string; data?: string; displayText?: string; uri?: string
  mode?: string; initial?: string; min?: string; max?: string
}

export type DemoCtx = {
  state: DemoState | null
  me: Persona | null
  personaName: (key: string | undefined) => string
  refresh: () => void
  openLiff: (target: LiffTarget) => void
  /** Runs a Flex / template action as the current persona. */
  runAction: (action: FlexActionLike, params?: PostbackParams) => void
}

export const DemoContext = createContext<DemoCtx | null>(null)

export function useDemo(): DemoCtx {
  const ctx = useContext(DemoContext)
  if (!ctx) throw new Error('useDemo outside DemoContext')
  return ctx
}

/** {view, id} of a demo LIFF link, or null for any other URL. */
export function parseDemoLiff(uri: string): LiffTarget | null {
  if (!uri.startsWith(DEMO_LIFF_PREFIX)) return null
  try {
    const u = new URL(uri)
    const view = u.searchParams.get('view')
    if (view) return { view, id: u.searchParams.get('id') }
    const state = u.searchParams.get('liff.state')
    if (state) {
      const q = new URLSearchParams(state.slice(state.indexOf('?') + 1))
      const v = q.get('view')
      if (v) return { view: v, id: q.get('id') }
    }
    return null
  } catch {
    return null
  }
}

const PALETTE = [
  { bg: '#FDE2E4', fg: '#B4234A' },
  { bg: '#DCEBFF', fg: '#1F5FB0' },
  { bg: '#E3F6E8', fg: '#1B7A43' },
  { bg: '#FFF1D6', fg: '#A15C00' },
  { bg: '#EDE4FF', fg: '#6236C5' },
  { bg: '#D9F4F4', fg: '#0F7272' },
]
const FIXED: Record<string, number> = { nont: 0, tae: 1, bomb: 4, jeff: 2 }

export function personaTone(key: string): { bg: string; fg: string } {
  if (key in FIXED) return PALETTE[FIXED[key]]
  let h = 0
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function initialOf(name: string): string {
  const chars = Array.from(name.trim())
  const first = chars.find((c) => !'เแโใไ'.includes(c)) ?? chars[0]
  return first ? first.toUpperCase() : '?'
}
