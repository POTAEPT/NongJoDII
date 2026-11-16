import type { LineQuickReply } from '../line/types'

// UX review 1.2: quick reply buttons under a bot message. Each one sends the command as the
// person's own message, so the bot answers it with the reply token of that message (free, no
// push), exactly as if they had typed it. LINE shows them above the input box until the next
// message arrives. Labels stay under LINE's 20-character limit.

/** The exact text each command button sends (parse.ts reads it). */
export const COMMAND_TEXT = {
  summarize: 'น้องจดดี สรุป',
  settings: 'น้องจดดี ตั้งค่า',
  help: 'น้องจดดี วิธีใช้',
  requestFile: 'น้องจดดี ขอไฟล์',
  done: 'น้องจดดี done',
} as const

const BUTTON = {
  summarize: { label: '📝 สรุปแชต', text: COMMAND_TEXT.summarize },
  retrySummary: { label: '🔁 สรุปอีกครั้ง', text: COMMAND_TEXT.summarize },
  settings: { label: '⚙️ ตั้งค่า', text: COMMAND_TEXT.settings },
  help: { label: '❔ วิธีใช้', text: COMMAND_TEXT.help },
} as const

export type QuickButton = keyof typeof BUTTON

export function quickReply(...buttons: QuickButton[]): LineQuickReply {
  return { items: buttons.map((b) => ({ type: 'action', action: { type: 'message', ...BUTTON[b] } })) }
}

/** The everyday set: Summary, Settings, help. */
export function commandQuickReply(): LineQuickReply {
  return quickReply('summarize', 'settings', 'help')
}
