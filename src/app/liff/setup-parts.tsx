'use client'

import { QUARTER_HOURS } from '@/server/setup/rules'
import type { SetupFeatures } from '@/server/setup/types'
import { inputClass } from './ui'

// Pieces the setup form (#52) and Settings (#28) share.

export const FEATURES: { key: keyof SetupFeatures; label: string; sub: string }[] = [
  { key: 'summarize', label: 'สรุปงานจากแชต', sub: 'แยกงาน ผู้รับ และกำหนดส่ง ให้ทีมกดยืนยัน' },
  { key: 'saveFiles', label: 'เก็บไฟล์ลง Google Drive', sub: 'ไฟล์ในกลุ่มไม่หมดอายุ' },
  { key: 'trackRemind', label: 'ติดตามงาน + เตือน', sub: 'ถามปิดงาน และเตือนก่อนถึงกำหนด' },
  { key: 'weeklySummary', label: 'สรุปรายสัปดาห์', sub: 'โพสต์สรุปในกลุ่มทุกสัปดาห์' },
]

export function TimeSelect({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <select
      className={inputClass}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {QUARTER_HOURS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  )
}
