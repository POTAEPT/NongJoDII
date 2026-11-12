// LINE webhook (incoming) and Messaging API (outgoing) message shapes.
export type LineSource =
  | { type: 'user'; userId: string }
  | { type: 'group'; groupId: string; userId?: string }
  | { type: 'room'; roomId: string; userId?: string }
export type LineMention = { index: number; length: number; type: 'user' | 'all'; userId?: string; isSelf?: boolean }
export type LineMessageContent =
  | { id: string; type: 'text'; text: string; mention?: { mentionees: LineMention[] }; quotedMessageId?: string }
  | { id: string; type: 'image'; imageSet?: { id: string; index?: number; total?: number } }
  | { id: string; type: string; [k: string]: unknown } // file, video, audio, sticker, location...
export type LineEvent = {
  type: string                      // 'message' | 'follow' | 'join' | 'unsend' | ...
  timestamp: number                 // ms
  source: LineSource
  replyToken?: string
  webhookEventId: string
  deliveryContext: { isRedelivery: boolean }
  mode?: string
  message?: LineMessageContent
  postback?: { data: string }       // event.type 'postback'
}
export type LineWebhookBody = { destination: string; events: LineEvent[] }

export type LineUriAction = { type: 'uri'; label: string; uri: string }
export type LinePostbackAction = { type: 'postback'; label: string; data: string; displayText?: string }
export type LineMessage =
  | { type: 'text'; text: string }
  | { type: 'flex'; altText: string; contents: Record<string, unknown> }
  | { type: 'template'; altText: string; template: { type: 'buttons'; text: string; actions: LineUriAction[] } }
