'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from 'cn'
import { ChevronDown, ChevronUp, HardDrive, Keyboard, LayoutDashboard, LayoutGrid, ListTodo, SendHorizontal, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { demoApi } from '../_lib/api'
import { useDemo } from './demo-context'

/** The four Rich Menu tiles of the OA (#84). `text` is exactly what the tile sends, the
 *  words src/server/chat/menu.ts parses. */
const TILES: { text: string; label: string; icon: ReactNode }[] = [
  { text: 'Dashboard', label: 'แดชบอร์ด', icon: <LayoutDashboard /> },
  { text: 'งานของฉัน', label: 'งานของฉัน', icon: <ListTodo /> },
  { text: 'ตั้งค่า', label: 'ตั้งค่า', icon: <Settings /> },
  { text: 'เชื่อมต่อ Google Drive', label: 'เชื่อม Google Drive', icon: <HardDrive /> },
]

/** The bottom of the 1:1 chat with the bot, LINE style: the Rich Menu (a tile grid under a
 *  "เมนู" bar that folds it) or, after the keyboard button, a text composer. Both send a
 *  1:1 text message as "me" through the real webhook. */
export function DirectBottom({ onSent }: { onSent: () => void }) {
  const { me } = useDemo()
  const [mode, setMode] = useState<'menu' | 'keyboard'>('menu')
  const [open, setOpen] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const disabled = !me

  const send = async (t: string) => {
    if (!me || !t.trim() || sending) return
    setSending(true)
    try {
      await demoApi.sendDirect(me.key, t)
      onSent()
    } catch (e) {
      toast.error(`ส่งไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }

  const sendTyped = () => {
    const t = text.trim()
    if (!t) return
    setText('')
    void send(t)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendTyped()
    }
  }

  if (mode === 'keyboard') {
    return (
      <div className="flex items-end gap-1 border-t border-black/5 bg-white px-2 py-2">
        <BarButton label="แสดงเมนู" onClick={() => { setMode('menu'); setOpen(true) }}><LayoutGrid /></BarButton>
        <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-[20px] bg-[#EFF1F4] px-3.5">
          <textarea rows={1} value={text} disabled={disabled} autoFocus placeholder="Aa"
            onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
            className="max-h-24 min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-[#9AA4B2] field-sizing-content" />
        </div>
        <button type="button" onClick={sendTyped} disabled={disabled || sending || !text.trim()} aria-label="ส่ง"
          className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-(--line-green) text-white transition-opacity disabled:opacity-30">
          <SendHorizontal className="size-[18px]" />
        </button>
      </div>
    )
  }

  return (
    <div className="border-t border-black/5 bg-white">
      <div className="flex h-11 items-center gap-1 px-2">
        <BarButton label="พิมพ์ข้อความ" onClick={() => setMode('keyboard')}><Keyboard /></BarButton>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg text-[14px] font-semibold text-[#33435C] hover:bg-black/[0.04]">
          เมนู {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
        <span className="size-9 shrink-0" />
      </div>
      {open && (
        <div className="grid grid-cols-2 border-t border-black/5">
          {TILES.map((t, i) => (
            <button key={t.text} type="button" disabled={disabled || sending} onClick={() => void send(t.text)}
              className={cn(
                'flex h-[84px] flex-col items-center justify-center gap-1.5 bg-[#F4FBF7] text-[14px] font-semibold text-[#12613A] transition-colors',
                'hover:bg-[#E3F6EA] active:bg-[#D2F0DD] disabled:opacity-50 [&_svg]:size-7 [&_svg]:text-(--line-green)',
                i % 2 === 0 && 'border-r border-black/5', i < 2 && 'border-b border-black/5',
              )}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function BarButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-[#4A5568] hover:bg-black/5 [&_svg]:size-[22px]">
      {children}
    </button>
  )
}
