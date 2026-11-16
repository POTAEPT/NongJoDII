import { cleanTag, TAG_MAX_LENGTH, TAGS_MAX } from '@/server/tasks/tags'

// #109: the tag editor's rules on the page, the same as the server's (server/tasks/tags.ts).

export const TAGS_TEXT = {
  label: 'แท็ก',
  placeholder: 'เพิ่มแท็ก เช่น ออกแบบ',
  add: 'เพิ่ม',
  remove: (t: string) => `ลบแท็ก ${t}`,
  hint: (max: number = TAGS_MAX) => `ไม่เกิน ${max} แท็ก แท็กละไม่เกิน ${TAG_MAX_LENGTH} ตัวอักษร`,
  full: (max: number = TAGS_MAX) => `ใส่ได้ไม่เกิน ${max} แท็ก`,
  tooLong: `แท็กยาวได้ไม่เกิน ${TAG_MAX_LENGTH} ตัวอักษร`,
  duplicate: 'มีแท็กนี้แล้ว',
  suggested: 'แท็กของกลุ่ม แตะเพื่อเพิ่ม',
  addSuggested: (t: string) => `เพิ่มแท็ก ${t}`,
} as const

/** Adds what the person typed. Answers the new list, or why it was not added. Typing
 *  "#ออกแบบ" adds "ออกแบบ"; an empty input changes nothing. */
export function addTag(tags: string[], input: string, max: number = TAGS_MAX): { tags: string[]; error: string | null } {
  const raw = input.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '')
  if (raw === '') return { tags, error: null }
  if (Array.from(raw).length > TAG_MAX_LENGTH) return { tags, error: TAGS_TEXT.tooLong }
  const tag = cleanTag(raw)
  if (tag === null) return { tags, error: null }
  if (tags.some((t) => t.toLocaleLowerCase('th') === tag.toLocaleLowerCase('th'))) return { tags, error: TAGS_TEXT.duplicate }
  if (tags.length >= max) return { tags, error: TAGS_TEXT.full(max) }
  return { tags: [...tags, tag], error: null }
}

/** #144: the group's tags not on this Task yet, in the set's order (case-insensitive, as
 *  addTag compares). */
export function tagSuggestions(tagSet: readonly string[], tags: readonly string[]): string[] {
  const has = new Set(tags.map((t) => t.toLocaleLowerCase('th')))
  return tagSet.filter((t) => !has.has(t.toLocaleLowerCase('th')))
}

export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((t) => t !== tag)
}
