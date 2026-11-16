import type { AiCall } from './api'

/** Thai labels for the kinds of AI call (the toasts and the AI tab). */
export const AI_KIND: Record<AiCall['kind'], string> = { summary: 'สรุป', progress: 'ติดตามงาน', tags: 'แท็ก', other: 'อื่นๆ' }

/** '$0.000068'; '≈' when estimated from tokens; 'n/a' when unknown. */
export function usd(n: number | null, estimated = false): string {
  if (n === null) return 'n/a'
  return `${estimated ? '≈' : ''}$${n.toFixed(6)}`
}
