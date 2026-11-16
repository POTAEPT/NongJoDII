import { quickReply } from '../commands/quick-reply'
import { bubble, caption, header, text } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import { AdapterError } from '../log'
import { formatHhmm } from '../time/bangkok'
import { ModelOutputError } from './parse-output'

// What a failed Summary tells the group (2026-11-16: a Summary that failed said only "ลองใหม่",
// and the cause, a database error, was found only in the Vercel log, which Hobby keeps for an
// hour). The reply says what went wrong in plain words, whether trying again can help, and a
// short code with the Bangkok time so the team can find the log line. It never carries an
// error message or anything from the chat.

export type SummaryFailure = 'ai_timeout' | 'ai_busy' | 'ai_credits' | 'ai_output' | 'ai_error' | 'system'

const CODE: Record<SummaryFailure, string> = {
  ai_timeout: 'AI-TIME', ai_busy: 'AI-BUSY', ai_credits: 'AI-CREDIT', ai_output: 'AI-FORMAT', ai_error: 'AI', system: 'SYS',
}

// UX review 3.1: plain words, no "AI format" talk; the code stays, small, for the team.
export const SUMMARY_FAILED_TEXT: Record<SummaryFailure, string> = {
  ai_timeout: 'น้องจดดีคิดนานไปหน่อย ลองสั่งสรุปอีกครั้งในอีกสักครู่นะ',
  ai_busy: 'น้องจดดีไม่ว่างชั่วคราว ลองสั่งสรุปอีกครั้งในอีกสักครู่นะ',
  ai_credits: 'น้องจดดีสรุปไม่ได้ชั่วคราว ลองใหม่ยังไม่ได้ แจ้งทีมผู้พัฒนาพร้อมรหัสด้านล่างนะ',
  ai_output: 'น้องจดดีอ่านแชตแล้วงงนิดหน่อย ลองสั่งสรุปอีกครั้งนะ',
  ai_error: 'น้องจดดีสรุปไม่สำเร็จ ลองสั่งสรุปอีกครั้งในอีกสักครู่นะ',
  system: 'น้องจดดีขัดข้องชั่วคราว ไม่เกี่ยวกับแชตของกลุ่ม ลองใหม่ในอีกสักครู่ ถ้ายังไม่ได้ แจ้งทีมผู้พัฒนาพร้อมรหัสด้านล่างนะ',
}

export const SUMMARY_FAILED_CARD_TEXT = {
  title: 'สรุปไม่สำเร็จ',
  code: (code: string, hhmm: string) => `รหัสสำหรับแจ้งทีม: ${code} · ${hhmm}`,
} as const

/** `inAi`: the error came from the AI step (runMeteredAi or reading its output); anything
 *  else (the store, the members, saving the Summary) is the system's. */
export function summaryFailure(err: unknown, inAi: boolean): SummaryFailure {
  if (!inAi) return 'system'
  if (err instanceof ModelOutputError) return 'ai_output'
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'ai_timeout'
  if (err instanceof AdapterError) {
    if (err.message === 'openrouter timeout') return 'ai_timeout'
    const status = Number(/^openrouter (\d{3})$/.exec(err.message)?.[1])
    if (status === 402) return 'ai_credits'
    if (status === 429 || status >= 500) return 'ai_busy'
  }
  return 'ai_error'
}

/** "สรุปแชตไม่สำเร็จ: <reason>\nรหัส: SUM-<code> <HH:MM>" (Bangkok time). */
export function summaryFailedText(reason: SummaryFailure, at: Date): string {
  return `สรุปแชตไม่สำเร็จ: ${SUMMARY_FAILED_TEXT[reason]}\nรหัส: SUM-${CODE[reason]} ${formatHhmm(at)}`
}

/** UX review 3.1 / 3.3: the failure as a card (the text above is its notification text), the
 *  code small at the bottom, and a quick reply that sends the Summary command again, except
 *  when trying again cannot help (credits). */
export function summaryFailedCard(reason: SummaryFailure, at: Date): LineMessage {
  return {
    type: 'flex',
    altText: summaryFailedText(reason, at),
    contents: bubble([
      header('danger', SUMMARY_FAILED_CARD_TEXT.title),
      text(SUMMARY_FAILED_TEXT[reason], { color: '#545454' }),
      caption(SUMMARY_FAILED_CARD_TEXT.code(`SUM-${CODE[reason]}`, formatHhmm(at)), { size: 'xxs' }),
    ]),
    ...(reason === 'ai_credits' ? {} : { quickReply: quickReply('retrySummary', 'help') }),
  }
}
