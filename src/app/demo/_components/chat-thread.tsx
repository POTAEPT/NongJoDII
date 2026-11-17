'use client'

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from 'cn'
import { Copy, CornerUpLeft, FileText, Undo2 } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { ChatItem } from '../_lib/api'
import { bangkokDate, dateSeparator, timeLabel } from '../_lib/time'
import { BOT_NAME, BotAvatar, PersonaAvatar } from './avatars'
import { useDemo, type FlexActionLike } from './demo-context'
import { FlexMessage, TemplateButtons } from './flex-renderer'

type Msg = ChatItem['message']

export type ThreadItem = ChatItem & { local?: boolean }

/** Plain words for a quote preview or the reply bar. */
export function previewText(m: Msg): string {
  switch (m.type) {
    case 'text': return m.text
    case 'image': return 'รูปภาพ'
    case 'file': return `ไฟล์: ${m.fileName}`
    case 'sticker': return 'สติกเกอร์'
    case 'system': return m.text
    case 'flex': return m.altText
    case 'template': return m.altText
    default: return ''
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const URL_RE = /(https?:\/\/[^\s]+)/g

/** Text with links and @mentions highlighted, like LINE. */
function RichText({ text, names }: { text: string; names: string[] }) {
  const parts = text.split(URL_RE)
  const mentionRe = names.length > 0
    ? new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g')
    : null
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 1) {
          return <a key={i} href={p} target="_blank" rel="noreferrer" className="break-all text-[#2C64C6] underline">{p}</a>
        }
        if (!mentionRe) return <Fragment key={i}>{p}</Fragment>
        return (
          <Fragment key={i}>
            {p.split(mentionRe).map((q, j) => (j % 2 === 1
              ? <span key={j} className="font-semibold text-[#2C64C6]">{q}</span>
              : <Fragment key={j}>{q}</Fragment>))}
          </Fragment>
        )
      })}
    </>
  )
}

/** direct: the bot's 1:1 chat (no read count, no reply or unsend, its own empty text). */
export function ChatThread({ items, onReply, onUnsend, direct = false }: {
  items: ThreadItem[]
  onReply: (item: ThreadItem) => void
  onUnsend: (item: ThreadItem) => void
  direct?: boolean
}) {
  const { state, me, personaName } = useDemo()
  const scroller = useRef<HTMLDivElement>(null)
  const busy = !direct && (state?.ai.busy ?? false)
  const now = state?.now ?? items.at(-1)?.at ?? '1970-01-01T00:00:00Z'
  const names = [BOT_NAME, ...(state?.personas.map((p) => p.lineName) ?? []), 'All']
  const lastId = items.at(-1)?.id

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [lastId, items.length, busy])

  const byMessageId = new Map(items.filter((i) => i.messageId).map((i) => [i.messageId as string, i]))

  const rows: ReactNode[] = []
  let prevDay = ''
  let prevSender = ''
  for (const item of items) {
    const day = bangkokDate(item.at)
    if (day !== prevDay) {
      rows.push(<SystemPill key={`d-${item.id}`}>{dateSeparator(item.at, now)}</SystemPill>)
      prevDay = day
      prevSender = ''
    }
    const sender = item.from === 'bot' ? 'bot' : item.from === 'user' ? `u:${item.persona}` : 'system'
    if (item.from === 'system' || item.message.type === 'system') {
      rows.push(<SystemPill key={item.id}>{previewText(item.message)}</SystemPill>)
      prevSender = ''
      continue
    }
    if (item.unsent) {
      const who = item.persona === me?.key ? 'คุณ' : personaName(item.persona)
      rows.push(<SystemPill key={item.id}>{who} ยกเลิกข้อความแล้ว</SystemPill>)
      prevSender = ''
      continue
    }
    const showHead = sender !== prevSender
    prevSender = sender
    const quoted = item.message.type === 'text' && 'quotedMessageId' in item.message && item.message.quotedMessageId
      ? byMessageId.get(item.message.quotedMessageId) : undefined
    rows.push(
      <MessageRow key={item.id} item={item} mine={item.from === 'user' && item.persona === me?.key}
        showHead={showHead} quoted={quoted} names={names} onReply={onReply} onUnsend={onUnsend} direct={direct} />,
    )
  }

  return (
    <div ref={scroller} className="demo-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-(--line-chat-bg) px-3 pt-3 pb-4">
      {items.length === 0 && (
        <div className="mt-24 text-center text-sm text-[#4A5A73]">
          {direct
            ? <>ยังไม่มีข้อความ<br />กดเมนูด้านล่างเพื่อคุยกับน้องจดดี</>
            : <>ยังไม่มีข้อความ<br />เพิ่มน้องจดดีเข้ากลุ่ม แล้วเริ่มคุยได้เลย</>}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {rows}
        {busy && <TypingRow />}
      </div>
    </div>
  )
}

function SystemPill({ children }: { children: ReactNode }) {
  return (
    <div className="my-1 flex justify-center">
      <span className="max-w-[85%] rounded-full bg-black/20 px-3 py-1 text-center text-[12px] leading-snug text-white">{children}</span>
    </div>
  )
}

function TypingRow() {
  return (
    <div className="flex items-end gap-2">
      <BotAvatar />
      <div className="flex h-9 items-center gap-1 rounded-[18px] rounded-tl-[6px] bg-white px-4">
        <span className="demo-typing-dot size-2 rounded-full bg-[#9AA6B8]" />
        <span className="demo-typing-dot size-2 rounded-full bg-[#9AA6B8]" />
        <span className="demo-typing-dot size-2 rounded-full bg-[#9AA6B8]" />
      </div>
    </div>
  )
}

function MessageRow({ item, mine, showHead, quoted, names, onReply, onUnsend, direct }: {
  item: ThreadItem; mine: boolean; showHead: boolean; quoted: ThreadItem | undefined; names: string[]
  onReply: (item: ThreadItem) => void; onUnsend: (item: ThreadItem) => void; direct: boolean
}) {
  const { personaName, state } = useDemo()
  const [menu, setMenu] = useState(false)
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isBot = item.from === 'bot'
  const name = isBot ? BOT_NAME : personaName(item.persona)
  const m = item.message
  const canReply = !direct && !!item.messageId && !item.local
  const canUnsend = !direct && mine && !!item.messageId && !item.local
  const canCopy = m.type === 'text'
  const hasMenu = canReply || canUnsend || canCopy
  const readers = mine ? Math.max(0, (state?.personas.filter((p) => p.inGroup).length ?? 1) - 1 + (state?.group.botInGroup ? 1 : 0)) : 0

  const startPress = () => {
    if (!hasMenu) return
    press.current = setTimeout(() => setMenu(true), 450)
  }
  const endPress = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }

  // A carousel takes the full row width (it scrolls sideways), so it never squeezes its bubbles.
  const carousel = m.type === 'flex' && (m.contents as { type?: unknown }).type === 'carousel'

  const bubble = (
    <div onContextMenu={(e) => { if (hasMenu) { e.preventDefault(); setMenu(true) } }}
      onPointerDown={startPress} onPointerUp={endPress} onPointerLeave={endPress} onPointerCancel={endPress}
      className={cn('min-w-0', carousel && '-mr-3 self-stretch', menu && 'brightness-90')}>
      <Content item={item} mine={mine} quoted={quoted} names={names} />
    </div>
  )

  const meta = (
    <div className={cn('flex shrink-0 flex-col pb-0.5 text-[11px] leading-tight text-[#4A5A73]', mine ? 'items-end' : 'items-start')}>
      {mine && direct && <span>อ่านแล้ว</span>}
      {mine && !direct && readers > 0 && <span>อ่านแล้ว {readers}</span>}
      <span>{timeLabel(item.at)}</span>
    </div>
  )

  const wide = m.type === 'flex' || m.type === 'template'

  return (
    <div className={cn('flex gap-2', mine ? 'justify-end' : 'justify-start', !showHead && !mine && 'pl-11')}>
      {!mine && showHead && (isBot ? <BotAvatar /> : <PersonaAvatar personaKey={item.persona ?? ''} name={name} />)}
      <div className={cn('flex min-w-0 flex-col', mine ? 'items-end' : 'items-start',
        carousel ? 'flex-1' : wide ? 'max-w-[88%]' : 'max-w-[75%]')}>
        {!mine && showHead && <span className="mb-1 ml-1 text-[12px] font-medium text-[#33435C]">{name}</span>}
        {/* A carousel puts its time under the row (as LINE does), so the row reaches the edge
            and the next card peeks in. */}
        <div className={cn('flex min-w-0 gap-1.5', carousel ? 'w-full flex-col items-start' : 'items-end', mine && !carousel && 'flex-row-reverse')}>
          <Popover open={menu} onOpenChange={setMenu}>
            <PopoverAnchor asChild>{bubble}</PopoverAnchor>
            <PopoverContent side="top" align={mine ? 'end' : 'start'} sideOffset={6}
              className="w-auto flex-row gap-0 rounded-xl border-0 bg-[#2B2F36] p-1 text-white ring-0">
              {canReply && <MenuButton icon={<CornerUpLeft />} label="ตอบกลับ" onClick={() => { setMenu(false); onReply(item) }} />}
              {canCopy && <MenuButton icon={<Copy />} label="คัดลอก" onClick={() => { setMenu(false); void navigator.clipboard?.writeText(previewText(m)) }} />}
              {canUnsend && <MenuButton icon={<Undo2 />} label="ยกเลิกข้อความ" onClick={() => { setMenu(false); onUnsend(item) }} />}
            </PopoverContent>
          </Popover>
          {meta}
        </div>
      </div>
    </div>
  )
}

function MenuButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex min-w-16 flex-col items-center gap-1 rounded-lg px-2.5 py-2 text-[11px] hover:bg-white/10 [&_svg]:size-5">
      {icon}
      {label}
    </button>
  )
}

function Content({ item, mine, quoted, names }: { item: ThreadItem; mine: boolean; quoted: ThreadItem | undefined; names: string[] }) {
  const { personaName } = useDemo()
  const m = item.message
  const bubbleCls = cn(
    'rounded-[18px] px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words text-(--line-ink)',
    mine ? 'rounded-tr-[6px] bg-(--line-me)' : 'rounded-tl-[6px] bg-white',
  )
  switch (m.type) {
    case 'text':
      return (
        <div className={bubbleCls}>
          {quoted && (
            <div className="mb-1.5 border-b border-black/10 pb-1.5 text-[12px] text-black/60">
              <span className="font-semibold">{quoted.from === 'bot' ? BOT_NAME : personaName(quoted.persona)}</span>
              <span className="line-clamp-2">{previewText(quoted.message)}</span>
            </div>
          )}
          <RichText text={m.text} names={names} />
        </div>
      )
    case 'image':
      return (
        <a href={m.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[14px] bg-white/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={m.url} alt={m.fileName} className="block max-h-60 max-w-[200px] object-cover" />
        </a>
      )
    case 'file':
      return (
        <a href={m.url} target="_blank" rel="noreferrer"
          className={cn('flex w-[220px] items-center gap-3 rounded-[16px] px-3 py-3', mine ? 'bg-(--line-me)' : 'bg-white')}>
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#E8EEF7] text-[#1F5FB0]"><FileText className="size-5" /></span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold text-(--line-ink)">{m.fileName}</span>
            <span className="block text-[12px] text-black/50">{formatSize(m.size)}</span>
          </span>
        </a>
      )
    case 'sticker':
      return <Sticker />
    case 'flex':
      return <FlexMessage contents={m.contents} />
    case 'template':
      return <TemplateButtons template={m.template as { text?: string; title?: string; actions?: FlexActionLike[] }} />
    default:
      return <div className={bubbleCls}>{previewText(m)}</div>
  }
}

function Sticker() {
  return (
    <svg viewBox="0 0 120 120" className="size-28 drop-shadow-sm" aria-label="สติกเกอร์">
      <ellipse cx="60" cy="66" rx="44" ry="40" fill="#F5D7A1" />
      <circle cx="26" cy="32" r="13" fill="#F5D7A1" /><circle cx="94" cy="32" r="13" fill="#F5D7A1" />
      <circle cx="26" cy="32" r="7" fill="#E8B36E" /><circle cx="94" cy="32" r="7" fill="#E8B36E" />
      <ellipse cx="60" cy="66" rx="44" ry="40" fill="none" stroke="#5B3A1A" strokeWidth="3" />
      <circle cx="45" cy="60" r="4.5" fill="#3A2412" /><circle cx="75" cy="60" r="4.5" fill="#3A2412" />
      <ellipse cx="60" cy="74" rx="8" ry="5.5" fill="#3A2412" />
      <path d="M50 84 Q60 94 70 84" stroke="#3A2412" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="35" cy="76" r="6" fill="#F7A8A8" opacity="0.7" /><circle cx="85" cy="76" r="6" fill="#F7A8A8" opacity="0.7" />
      <g transform="translate(88 92) rotate(-15)">
        <rect x="-4" y="-16" width="8" height="18" rx="4" fill="#F5D7A1" stroke="#5B3A1A" strokeWidth="2.5" />
        <rect x="-10" y="0" width="20" height="16" rx="6" fill="#F5D7A1" stroke="#5B3A1A" strokeWidth="2.5" />
      </g>
    </svg>
  )
}
