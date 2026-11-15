import type { LineMessage } from '@/server/line/types'

// Test helpers for Flex cards built with src/server/line/flex-ui.ts. A card's buttons are
// Flex `button`s or `box`es with an action, and its words sit in many `text` nodes.

type Node = Record<string, unknown>

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const v of node) walk(v, visit)
    return
  }
  const n = node as Node
  visit(n)
  for (const v of Object.values(n)) walk(v, visit)
}

/** Every `text` node's words in order, one per line. */
export function nodeText(node: unknown): string {
  const out: string[] = []
  walk(node, (n) => {
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text)
  })
  return out.join('\n')
}

/** A message's words: a text message's text, or a Flex card's text nodes. */
export function messageText(m: LineMessage): string {
  if (m.type === 'text') return m.text
  if (m.type === 'flex') return nodeText(m.contents)
  return m.template.text
}

/** All messages' words, joined. */
export function messagesText(messages: LineMessage[]): string {
  return messages.map(messageText).join('\n')
}

/** Is this node a button: a Flex `button`, or a `box` with an action? */
export function isButton(n: Node): boolean {
  return (n.type === 'button' || n.type === 'box') && !!n.action && typeof n.action === 'object'
}

/** The actions of every button under `node`, in order. */
export function buttonActions<A = { type: string; label: string; data?: string; uri?: string }>(node: unknown): A[] {
  const out: A[] = []
  walk(node, (n) => {
    if (isButton(n)) out.push(n.action as A)
  })
  return out
}
