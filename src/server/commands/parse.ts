export type GroupCommand = 'summarize' | 'done' | 'need_time' | 'settings' | 'request_file' | 'help'
// The bot answers to its English name and its Thai name (Figma UI v4 #3: "น้องจดดี สรุปหน่อย").
// A command is the name, then the command word, then optional polite words and closing
// punctuation (#85), so people can type it the way they talk: "น้องจดดี ตั้งค่าหน่อยครับ",
// "น้องจดดี, สรุปให้หน่อยนะ!". It must still start with the name and have nothing else after
// the command, so ordinary chat that only mentions a word ("ตั้งค่าห้องแล้ว") is not one.
// Commands are also kept out of Summaries (summary/run-summary.ts).
const NAME = '@?(?:nongjodii|น้องจดดี)'
/** Between the name and the command: spaces, and at most one comma or colon. */
const SEP = '\\s*[,:]?\\s*'
/** Polite words after the command, any number, in any order. */
const POLITE = '(?:\\s*(?:ให้|หน่อย|ด้วย|ครับ|คับ|ค่ะ|คะ|ค่า|นะ|น้า|จ้า|จ้ะ|please|pls))*'
/** Closing punctuation. */
const END = '\\s*[!.?~ๆ]*'
const command = (words: string) => new RegExp(`^${NAME}${SEP}(?:${words})${POLITE}${END}$`, 'i')

const SUMMARIZE = command('summarize|สรุป')
// Typed fallbacks for the reminder buttons (#8, #45).
const DONE = command('done')
const NEED_TIME = command('need time')
// Opens Settings (#28).
const SETTINGS = command('settings|ตั้งค่า')
// Asks for a saved file's Drive link; only meaningful as a quote-reply to the file message (#33).
const REQUEST_FILE = command('ขอไฟล์')
// UX review 1.3: what the bot can do. The bot's name alone ("น้องจดดี", "@น้องจดดี") asks the same.
const HELP = command('วิธีใช้|ช่วยด้วย|ช่วยเหลือ|help')
const NAME_ONLY = new RegExp(`^${NAME}${POLITE}${END}$`, 'i')

export function parseGroupCommand(text: string | null): GroupCommand | null {
  if (!text) return null
  const t = text.trim().replace(/\s+/g, ' ')
  if (SUMMARIZE.test(t)) return 'summarize'
  if (DONE.test(t)) return 'done'
  if (NEED_TIME.test(t)) return 'need_time'
  if (SETTINGS.test(t)) return 'settings'
  if (REQUEST_FILE.test(t)) return 'request_file'
  if (HELP.test(t) || NAME_ONLY.test(t)) return 'help'
  return null
}
