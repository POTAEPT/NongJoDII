// #109: tags on Tasks. One rule set for every way a tag arrives: the model's suggestion
// (Summary), the review page and the Task page. The database also caps the count
// (tasks_tags_max, task_candidates_suggested_tags_max in 20261116160000_task_tags.sql).

/** Tags on one Task. */
export const TAGS_MAX = 5
/** Characters in one tag (after the rules below). */
export const TAG_MAX_LENGTH = 20
/** #110: tags in a group's starting set (setup form, Settings). */
export const TAG_SET_MAX = 20
/** Tags the model may suggest for one task. */
export const SUGGESTED_TAGS_MAX = 3

/** One tag as stored: spaces trimmed and collapsed, a leading "#" dropped, at most
 *  TAG_MAX_LENGTH characters. null when nothing is left. */
export function cleanTag(raw: string): string | null {
  const t = raw.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '')
  if (t === '') return null
  return Array.from(t).slice(0, TAG_MAX_LENGTH).join('')
}

/** Tags from the model: anything that is not a string is dropped, duplicates
 *  (case-insensitive) are dropped, and at most `max` are kept. Never fails. */
export function suggestedTags(raw: unknown, max = SUGGESTED_TAGS_MAX): string[] {
  if (!Array.isArray(raw)) return []
  return dedupe(raw.flatMap((x) => (typeof x === 'string' ? [cleanTag(x)] : [])).filter((x): x is string => x !== null)).slice(0, max)
}

/** Tags a person sent (review page, Task page): an array of strings, each non-empty after
 *  cleanTag and at most TAG_MAX_LENGTH characters, at most `max` (TAGS_MAX on a Task,
 *  TAG_SET_MAX for a group's set) after duplicates are dropped. null = refused (the caller answers 400 tags). Missing (undefined) is []. */
export function personTags(raw: unknown, max = TAGS_MAX): string[] | null {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const x of raw) {
    if (typeof x !== 'string') return null
    const t = x.replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '')
    if (t === '' || Array.from(t).length > TAG_MAX_LENGTH) return null
    out.push(t)
  }
  const tags = dedupe(out)
  return tags.length > max ? null : tags
}

function dedupe(tags: string[]): string[] {
  const seen = new Set<string>()
  return tags.filter((t) => {
    const k = t.toLocaleLowerCase('th')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
