'use client'

import { QUARTER_HOURS } from '@/server/setup/rules'
import type { SetupFeatures } from '@/server/setup/types'

// Pieces the setup form (#52) and Settings (#28) share.

export const FEATURES: { key: keyof SetupFeatures; label: string; sub: string }[] = [
  { key: 'summarize', label: 'สรุปงานจากแชต', sub: 'ร่างงานให้ทีมกดยืนยัน' },
  { key: 'saveFiles', label: 'เก็บไฟล์ลง Google Drive', sub: 'ไฟล์ในแชตไปอยู่โฟลเดอร์ของกลุ่ม' },
  { key: 'trackRemind', label: 'ติดตามงาน + เตือน', sub: 'ถามปิดงาน และเตือนงานใกล้ครบกำหนด' },
  { key: 'weeklySummary', label: 'สรุปรายสัปดาห์', sub: 'โพสต์สรุปในกลุ่มทุกสัปดาห์' },
]

export function TimeSelect({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <select
      className="mt-1 w-full rounded border p-2"
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
