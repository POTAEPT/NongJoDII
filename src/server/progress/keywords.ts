import type { ProgressTarget } from '../ports'

// Free keyword gate (#132): a chat line without one of these words makes no model call.
// On a match the decision model decides the Task and status; when no model answers, the
// keyword's status is used to ask the group "อัปเดตนี้หมายถึงงานไหน?". It never changes a
// Task: a person still answers. Progress phrased without a listed word is missed until
// someone adds the word here. Words match as plain substrings, so "เสร็จ" also covers
// "เสร็จแล้ว", "เสร็จละ", "ทำเสร็จละ", "เสร็จเรียบร้อย" and "อัปโหลดเสร็จ".

const DONE_WORDS = [
  'เสร็จ', 'เรียบร้อย', 'ส่งแล้ว', 'ส่งไฟล์แล้ว', 'ส่งงานแล้ว', 'อัปแล้ว', 'อัพแล้ว', 'อัปโหลดแล้ว',
  'อัปไดรฟ์แล้ว', 'อัพไดรฟ์แล้ว', 'อัปไดร์ฟแล้ว', 'อัพไดร์ฟแล้ว', 'ปิดงาน',
  'done', 'finished', 'completed', 'submitted',
]
// "ให้เอง" / "จัดการเอง" (E2E round 2, step 3.5): "เดี๋ยวเราจองห้องประชุมให้เอง" takes the
// room booking without the word ทำ.
const STARTED_WORDS = [
  'เริ่มทำ', 'เริ่มแล้ว', 'กำลังทำ', 'เดี๋ยวทำ', 'ทำเอง', 'ให้เอง', 'จัดการเอง', 'เดี๋ยวจัดการ', 'รับไป', 'รับเอง',
  'started', 'working on', 'on it',
]
// "ยังไม่เสร็จ" is not done, and neither is a question about it ("เสร็จยัง").
const NOT_DONE = [
  'ยังไม่เสร็จ', 'ไม่เสร็จ', 'not done', 'not finished',
  'เสร็จยัง', 'เสร็จหรือยัง', 'เสร็จไหม', 'เสร็จมั้ย', 'เสร็จเมื่อไหร่', 'done yet',
]

/** The status the line seems to report, or null for ordinary chat. */
export function looksLikeProgress(text: string): ProgressTarget | null {
  const t = text.toLowerCase()
  if (DONE_WORDS.some((w) => t.includes(w)) && !NOT_DONE.some((w) => t.includes(w))) return 'done'
  if (STARTED_WORDS.some((w) => t.includes(w))) return 'in_process'
  return null
}
