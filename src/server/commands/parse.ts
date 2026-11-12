export type GroupCommand = 'summarize'
const SUMMARIZE = /^@?nongjodii\s*(summarize|สรุปหน่อย)$/i
export function parseGroupCommand(text: string | null): GroupCommand | null {
  if (!text) return null
  return SUMMARIZE.test(text.trim().replace(/\s+/g, ' ')) ? 'summarize' : null
}
