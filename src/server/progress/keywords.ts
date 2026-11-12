import type { ProgressTarget } from '../ports'

// Free keyword check, used only when no model answered (both failed, the Fair-use cap
// is reached, or the group has no confirmed Owner to bill). It decides whether to ask
// the group "อัปเดตนี้หมายถึงงานไหน?"; it never changes a Task: a person still picks.

const DONE_WORDS = [
  'เสร็จ', 'เรียบร้อย', 'ส่งแล้ว', 'อัปแล้ว', 'อัพแล้ว', 'อัปโหลดแล้ว', 'ปิดงาน',
  'done', 'finished', 'completed', 'submitted',
]
const STARTED_WORDS = ['เริ่มทำ', 'เริ่มแล้ว', 'กำลังทำ', 'เดี๋ยวทำ', 'ทำเอง', 'รับไป', 'started', 'working on', 'on it']
// "ยังไม่เสร็จ" is not done.
const NOT_DONE = ['ยังไม่เสร็จ', 'ไม่เสร็จ', 'not done', 'not finished']

/** The status the line seems to report, or null for ordinary chat. */
export function looksLikeProgress(text: string): ProgressTarget | null {
  const t = text.toLowerCase()
  if (DONE_WORDS.some((w) => t.includes(w)) && !NOT_DONE.some((w) => t.includes(w))) return 'done'
  if (STARTED_WORDS.some((w) => t.includes(w))) return 'in_process'
  return null
}
