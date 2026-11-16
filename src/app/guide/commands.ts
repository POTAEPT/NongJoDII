import type { GroupCommand } from '@/server/commands/parse'

// The command table of /guide (#133). Keyed by GroupCommand, so adding a command to
// src/server/commands/parse.ts breaks the typecheck until it is listed here, and
// test/guide.test.ts checks that every example below really parses to its command.

export type GuideCommand = {
  /** What to type, exactly as parse.ts reads it. */
  text: string
  /** Other ways to type it, if any. */
  also?: string[]
  /** What the bot answers. */
  answer: string
}

export const GUIDE_COMMANDS: Record<GroupCommand, GuideCommand> = {
  summarize: {
    text: 'น้องจดดี สรุป',
    also: ['น้องจดดี สรุปหน่อย'],
    answer: 'สรุปแชตใหม่ตั้งแต่ครั้งก่อน แล้วร่างเป็นงานให้ทีมตรวจและกดยืนยัน',
  },
  settings: {
    text: 'น้องจดดี ตั้งค่า',
    answer: 'ปุ่มเปิดหน้าตั้งค่ากลุ่ม เจ้าของบอทแก้ได้ สมาชิกคนอื่นดูได้และแก้ข้อมูลของตัวเอง',
  },
  help: {
    text: 'น้องจดดี วิธีใช้',
    also: ['น้องจดดี', 'น้องจดดี help'],
    answer: 'การ์ดสรุปคำสั่งทั้งหมด และปุ่มเปิดหน้านี้',
  },
  done: {
    text: 'น้องจดดี done',
    answer: 'ถามว่างานไหนของคุณเสร็จแล้ว (ใช้แทนปุ่ม “เสร็จแล้ว” ในการ์ดเตือน)',
  },
  need_time: {
    text: 'น้องจดดี need time',
    answer: 'ถามว่าจะเลื่อนงานไหนไปวันไหน (ใช้แทนปุ่ม “ขอเลื่อน” ในการ์ดเตือน)',
  },
  request_file: {
    text: 'น้องจดดี ขอไฟล์',
    answer: 'ตอบกลับ (reply) ข้อความไฟล์หรือรูปในกลุ่ม แล้วพิมพ์คำนี้ น้องจดดีส่งลิงก์ไฟล์ใน Google Drive ให้',
  },
}

/** Table order on the page. */
export const GUIDE_COMMAND_ORDER: GroupCommand[] = ['summarize', 'settings', 'help', 'done', 'need_time', 'request_file']
