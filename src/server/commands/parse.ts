export type GroupCommand = 'summarize' | 'done' | 'need_time' | 'settings'
const SUMMARIZE = /^@?nongjodii\s*(summarize|สรุปหน่อย)$/i
// Typed fallbacks for the reminder buttons (#8, #45).
const DONE = /^@?nongjodii\s*done$/i
const NEED_TIME = /^@?nongjodii\s*need time$/i
// Opens Settings (#28).
const SETTINGS = /^@?nongjodii\s*(settings|ตั้งค่า)$/i
export function parseGroupCommand(text: string | null): GroupCommand | null {
  if (!text) return null
  const t = text.trim().replace(/\s+/g, ' ')
  if (SUMMARIZE.test(t)) return 'summarize'
  if (DONE.test(t)) return 'done'
  if (NEED_TIME.test(t)) return 'need_time'
  if (SETTINGS.test(t)) return 'settings'
  return null
}
