import { STATUS, bubble, caption, header, progressBar, row, text } from '../line/flex-ui'
import type { LineMessage } from '../line/types'
import type { StorePort } from '../ports'
import { bangkokMonthRange, formatThaiDateLong } from '../time/bangkok'

export const FAIR_USE_CAP_USD = 0.5
export const FAIR_USE_CAP_TOKENS = 6_000_000
export const FAIR_USE_WARN_FRACTION = 0.8
export const FAIR_USE_CAP_MICRO_USD = 500_000 // compare integers, never summed floats

export type FairUseStatus = {
  tokens: number; costMicroUsd: number; fraction: number
  level: 'under' | 'warn' | 'capped'; resetAt: Date; monthStartBkk: string
}

/** Per Owner, across every group the Owner admins, for the Bangkok month holding `now`. */
export async function getFairUseStatus(store: StorePort, ownerLineUserId: string, now: Date): Promise<FairUseStatus> {
  const range = bangkokMonthRange(now)
  const { tokens, costMicroUsd } = await store.sumOwnerMonthUsage(ownerLineUserId, range.monthStartBkk)
  const fraction = Math.max(tokens / FAIR_USE_CAP_TOKENS, costMicroUsd / FAIR_USE_CAP_MICRO_USD)
  // Integer form of the 80% line (warn fraction 0.8 = 4/5).
  const level =
    tokens >= FAIR_USE_CAP_TOKENS || costMicroUsd >= FAIR_USE_CAP_MICRO_USD
      ? 'capped'
      : tokens * 5 >= FAIR_USE_CAP_TOKENS * 4 || costMicroUsd * 5 >= FAIR_USE_CAP_MICRO_USD * 4
        ? 'warn'
        : 'under'
  return { tokens, costMicroUsd, fraction, level, resetAt: range.end, monthStartBkk: range.monthStartBkk }
}

export const FAIR_USE_TEXT = {
  warnTitle: 'ใกล้ถึงขีดจำกัดแผนฟรี',
  capTitle: 'ใช้ AI ครบโควตาฟรีของเดือนนี้แล้ว',
  usedLabel: 'ใช้ AI เดือนนี้',
  warnBody: 'ถ้าเต็ม น้องจดดีจะหยุดสรุปแชตจนถึงต้นเดือนหน้า แต่งานที่สร้างไว้ยังอยู่ครบ ไม่ต้องห่วง',
  resetLine: (reset: string) => `โควตาจะเริ่มใหม่วันที่ ${reset} เวลา 00:00 น.`,
  capBody: (reset: string) => `น้องจดดีจะหยุดสรุปแชตไว้ก่อน สรุปได้อีกครั้งวันที่ ${reset} เวลา 00:00 น. (เวลาประเทศไทย) งานที่สร้างไว้ยังอยู่ครบ`,
} as const

/** Figma UI v4 #10: the tone header, the month's usage bar and what happens at the cap. */
function usageCard(s: FairUseStatus, altText: string, capped: boolean): LineMessage {
  const pct = capped ? 100 : Math.floor(s.fraction * 100)
  const reset = formatThaiDateLong(s.resetAt)
  return {
    type: 'flex',
    altText,
    contents: bubble([
      header('warning', capped ? FAIR_USE_TEXT.capTitle : FAIR_USE_TEXT.warnTitle),
      row(caption(FAIR_USE_TEXT.usedLabel, { flex: 1 }), text(`${pct}%`, { flex: 0, size: 'xs', weight: 'bold', color: STATUS.not_assigned.fg })),
      progressBar(pct / 100, STATUS.not_assigned.dot),
      text(capped ? FAIR_USE_TEXT.capBody(reset) : FAIR_USE_TEXT.warnBody, { color: '#545454' }),
      ...(capped ? [] : [caption(FAIR_USE_TEXT.resetLine(reset))]),
      // UX review 3.2: no token or dollar figures in the group: the percentage and the reset
      // date say it. The exact figures stay in the logs and the store.
    ]),
  }
}

export function capMessage(s: FairUseStatus): LineMessage {
  const altText = [
    'ใช้ AI ครบโควตาฟรีของเดือนนี้แล้ว น้องจดดีจะหยุดสรุปแชตไว้ก่อน',
    `สรุปแชตได้อีกครั้งวันที่ ${formatThaiDateLong(s.resetAt)} เวลา 00:00 น. (เวลาประเทศไทย)`,
  ].join(' ')
  return usageCard(s, altText, true)
}

export function warnMessage(s: FairUseStatus): LineMessage {
  const altText = `แจ้งเตือน: ใช้ AI ไปแล้ว ${Math.floor(s.fraction * 100)}% ของโควตาฟรีเดือนนี้`
  return usageCard(s, altText, false)
}
