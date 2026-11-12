import type { ProgressLiffBody } from '@/server/progress/liff'

// State of the LIFF progress page (#7), kept pure so it can be tested without a DOM.
// Rule: once the page shows Task choices, they stay until a press actually finishes
// (updated / kept / dismissed). A failed or refused pick shows a notice above the same
// choices, so the person can retry or pick another Task.

export type ProgressPage = {
  sending: boolean
  /** The last answer from the server; null before the first one. */
  body: ProgressLiffBody | null
  /** An error or a non-final answer shown above choices that stay on screen. */
  notice: string | null
  /** Set when there is nothing on screen to retry from (the first send failed). */
  fatal: string | null
}

export type SendResult = { ok: true; body: ProgressLiffBody } | { ok: false; message: string }

export const initialPage: ProgressPage = { sending: true, body: null, notice: null, fatal: null }

const FINAL = new Set(['updated', 'kept', 'dismissed'])

export function startSend(page: ProgressPage): ProgressPage {
  return { ...page, sending: true, notice: null }
}

export function finishSend(page: ProgressPage, res: SendResult): ProgressPage {
  const hasChoices = (page.body?.choices.length ?? 0) > 0
  if (!res.ok) {
    return hasChoices
      ? { ...page, sending: false, notice: res.message }
      : { sending: false, body: null, notice: null, fatal: res.message }
  }
  // A non-final answer without choices (refused, already answered, gone) after a pick
  // keeps the earlier choices on screen.
  if (hasChoices && res.body.choices.length === 0 && !FINAL.has(res.body.result)) {
    return { ...page, sending: false, notice: res.body.text }
  }
  return { sending: false, body: res.body, notice: null, fatal: null }
}
