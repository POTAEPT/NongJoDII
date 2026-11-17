'use client'

import { QUARTER_HOURS } from '@/server/setup/rules'
import type { SetupFeatures } from '@/server/setup/types'
import { inputClass } from './ui'

// Pieces the setup form (#52) and Settings (#28) share.

export const FEATURES: { key: keyof SetupFeatures; label: string; sub: string }[] = [
  { key: 'summarize', label: 'สรุปงานจากแชต', sub: 'แยกงาน ผู้รับ และกำหนดส่ง ให้ทีมกดยืนยัน' },
  { key: 'saveFiles', label: 'เก็บไฟล์ลง Google Drive', sub: 'ไฟล์ในกลุ่มไม่หมดอายุ' },
  { key: 'trackRemind', label: 'ติดตามงาน + เตือน', sub: 'ถามปิดงานเมื่อมีคนพิมพ์ว่าเสร็จ และโพสต์เตือนงานในกลุ่มทุกวันตามเวลาที่เลือก' },
  { key: 'weeklySummary', label: 'สรุปรายสัปดาห์', sub: 'โพสต์จำนวนงานในกลุ่มทุกสัปดาห์ ทุกคนในกลุ่มเห็น' },
]

/** #143: what the bot Owner is, said where the Owner is chosen. */
export const OWNER_ROLE = {
  title: 'เจ้าของบอทคือใคร',
  items: [
    'เก็บไฟล์ของกลุ่มลง Google Drive ของตัวเอง',
    'โควตา AI ฟรีของกลุ่มนับที่คนนี้',
    'แก้การตั้งค่ากลุ่มได้ (คนอื่นแก้ได้แค่ชื่อเล่นของตัวเอง)',
    'ต้องกดยืนยันด้วย LINE ของตัวเองก่อนจึงมีผล',
  ],
  pick: 'แตะ “เลือกเป็นเจ้าของบอท” ที่การ์ดของคนที่จะดูแลบอท',
  chosen: 'เจ้าของบอท',
  choose: 'เลือกเป็นเจ้าของบอท',
} as const

export function OwnerRoleNote() {
  return (
    <section className="rounded-2xl bg-primary-soft p-4 text-sm text-ink">
      <p className="font-semibold">{OWNER_ROLE.title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
        {OWNER_ROLE.items.map((t) => <li key={t}>{t}</li>)}
      </ul>
      <p className="mt-2 text-xs text-ink-2">{OWNER_ROLE.pick}</p>
    </section>
  )
}

/** #143: the group's tag set is for Tasks; say what it does. */
export const TAG_SET_COPY = {
  label: 'แท็กงานของกลุ่ม (ไม่บังคับ)',
  hint: 'แท็กใช้จัดประเภทงานที่น้องจดดีสรุป เช่น ออกแบบ, เอกสาร, ประชุม น้องจดดีจะเลือกแท็กจากชุดนี้ก่อน ใช้คำเดียวต่อหนึ่งความหมาย เช่น เลือก “ออกแบบ” หรือ “Design” อย่างใดอย่างหนึ่ง',
} as const

/** #143: under each time, what it posts and who sees it, and why it may be off. */
export const TIMES_COPY = {
  dailyWhat: 'โพสต์ในกลุ่ม: งานใกล้ครบกำหนด เลยกำหนด และงานที่ยังไม่มีผู้รับ ทุกคนในกลุ่มเห็น',
  weeklyWhat: 'โพสต์จำนวนงานเสร็จ กำลังทำ และยังไม่มีผู้รับ ทุกคนในกลุ่มเห็น เจ้าของบอทได้สรุปรายคนในแชตส่วนตัว',
  dailyOff: 'ปิด “ติดตามงาน + เตือน” อยู่ จึงไม่มีการเตือนรายวัน เปิดฟีเจอร์ก่อนถ้าต้องการเลือกเวลา',
  weeklyOff: 'ปิด “สรุปรายสัปดาห์” อยู่ จึงไม่มีโพสต์รายสัปดาห์ เปิดฟีเจอร์ก่อนถ้าต้องการเลือกเวลา',
} as const

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
