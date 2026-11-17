import type { LiffAutofill } from '@/app/liff/autofill'
import type { SetupForm } from '@/app/liff/setup-model'
import type { SetupLoad } from '@/server/setup/types'
import type { DemoState } from '@/server/demo/types'

// "✨ เติมข้อมูลตัวอย่าง" in the demo's setup form: fills only what is empty, from the demo
// personas (nicknames, role) and the group's name, so the presenter can show the form
// without typing on stage. Times, features, Owner and the attach choice stay as they are.

type Persona = Pick<DemoState['personas'][number], 'lineUserId' | 'role' | 'nicknames'>

/** The seeded groups' own descriptions (src/app/demo/groups); other groups get a generic one. */
const WORK: Record<string, string> = {
  'ทีมพิตช์ NongJoDII': 'เตรียมงานพิตช์รอบสุดท้ายของทีม NongJoDII',
  'ทีม Dev': 'พัฒนาแอปเดโม NongJoDII ให้พร้อมพิตช์',
  'ลูกค้า ร้านกาแฟ': 'ทำแบรนด์และเพจให้ร้านกาแฟเปิดใหม่',
}

export const DEMO_TAGS = ['ออกแบบ', 'พัฒนา', 'การตลาด', 'ลูกค้า']

export function demoWorkDescription(groupName: string | null): string {
  if (groupName && WORK[groupName]) return WORK[groupName]
  return `${groupName ? `กลุ่ม ${groupName}` : 'กลุ่มนี้'} ทำโปรเจกต์ร่วมกัน แบ่งงานให้แต่ละคนและติดตามกำหนดส่งในแชต`
}

export function fillSetupForm(form: SetupForm, view: SetupLoad, personas: Persona[]): SetupForm {
  const byId = new Map(personas.map((p) => [p.lineUserId, p]))
  return {
    ...form,
    workDescription: form.workDescription.trim() ? form.workDescription : demoWorkDescription(view.groupName),
    tagSet: form.tagSet.length > 0 ? form.tagSet : [...DEMO_TAGS],
    members: form.members.map((m) => {
      const p = byId.get(m.lineUserId)
      if (!p) return m
      const hasNickname = m.nicknames.some((n) => n.trim() !== '')
      return {
        ...m,
        nicknames: hasNickname ? m.nicknames : [...p.nicknames],
        role: m.role.trim() ? m.role : (p.role ?? ''),
      }
    }),
  }
}

export function demoAutofill(personas: Persona[]): LiffAutofill {
  return { setup: (form, view) => fillSetupForm(form, view, personas) }
}
