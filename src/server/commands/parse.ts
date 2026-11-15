export type GroupCommand = 'summarize' | 'done' | 'need_time' | 'settings' | 'request_file'
// The bot answers to its English name and its Thai name (Figma UI v4 #3: "น้องจดดี สรุปหน่อย").
const NAME = '@?(?:nongjodii|น้องจดดี)'
const SUMMARIZE = new RegExp(`^${NAME}\\s*(summarize|สรุปหน่อย)$`, 'i')
// Typed fallbacks for the reminder buttons (#8, #45).
const DONE = new RegExp(`^${NAME}\\s*done$`, 'i')
const NEED_TIME = new RegExp(`^${NAME}\\s*need time$`, 'i')
// Opens Settings (#28).
const SETTINGS = new RegExp(`^${NAME}\\s*(settings|ตั้งค่า)$`, 'i')
// Asks for a saved file's Drive link; only meaningful as a quote-reply to the file message (#33).
const REQUEST_FILE = new RegExp(`^${NAME}\\s*ขอไฟล์$`, 'i')
export function parseGroupCommand(text: string | null): GroupCommand | null {
  if (!text) return null
  const t = text.trim().replace(/\s+/g, ' ')
  if (SUMMARIZE.test(t)) return 'summarize'
  if (DONE.test(t)) return 'done'
  if (NEED_TIME.test(t)) return 'need_time'
  if (SETTINGS.test(t)) return 'settings'
  if (REQUEST_FILE.test(t)) return 'request_file'
  return null
}
