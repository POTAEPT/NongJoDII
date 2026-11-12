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

function usageLine(s: FairUseStatus): string {
  return `ใช้ไป ${s.tokens.toLocaleString('en-US')} / ${FAIR_USE_CAP_TOKENS.toLocaleString('en-US')} โทเคน และ $${(s.costMicroUsd / 1e6).toFixed(4)} / $${FAIR_USE_CAP_USD.toFixed(2)}`
}

export function capMessage(s: FairUseStatus): LineMessage {
  return {
    type: 'text',
    text: [
      'ใช้ AI ครบโควตาฟรีของเดือนนี้แล้ว น้องจดดีจะหยุดสรุปแชทไว้ก่อน',
      usageLine(s),
      `สรุปแชทได้อีกครั้งวันที่ ${formatThaiDateLong(s.resetAt)} เวลา 00:00 น. (เวลาประเทศไทย)`,
    ].join('\n'),
  }
}

export function warnMessage(s: FairUseStatus): LineMessage {
  return {
    type: 'text',
    text: [
      `แจ้งเตือน: ใช้ AI ไปแล้ว ${Math.floor(s.fraction * 100)}% ของโควตาฟรีเดือนนี้`,
      usageLine(s),
      `โควตาจะเริ่มใหม่วันที่ ${formatThaiDateLong(s.resetAt)} เวลา 00:00 น.`,
    ].join('\n'),
  }
}
