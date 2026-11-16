import { AdapterError } from '../log'
import { bangkokParts } from '../time/bangkok'
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

export const SUMMARY_FAILED_TEXT: Record<SummaryFailure, string> = {
  ai_timeout: 'AI ใช้เวลานานเกินไป ลองสั่งสรุปใหม่อีกครั้งในอีกสักครู่',
  ai_busy: 'ระบบ AI ไม่ว่างหรือขัดข้องชั่วคราว ลองสั่งสรุปใหม่อีกครั้งในอีกสักครู่',
  ai_credits: 'เครดิต AI ของระบบน้องจดดีหมด ลองใหม่ยังไม่ได้ กรุณาแจ้งทีมผู้พัฒนาพร้อมรหัสด้านล่าง',
  ai_output: 'AI ตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองสั่งสรุปใหม่อีกครั้ง',
  ai_error: 'เรียกใช้ AI ไม่สำเร็จ ลองสั่งสรุปใหม่อีกครั้งในอีกสักครู่',
  system: 'ระบบของน้องจดดีขัดข้อง ไม่เกี่ยวกับแชตของกลุ่ม ลองใหม่ในอีกสักครู่ ถ้ายังไม่ได้ กรุณาแจ้งทีมผู้พัฒนาพร้อมรหัสด้านล่าง',
}

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
  const p = bangkokParts(at)
  const hhmm = `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
  return `สรุปแชตไม่สำเร็จ: ${SUMMARY_FAILED_TEXT[reason]}\nรหัส: SUM-${CODE[reason]} ${hhmm}`
}
