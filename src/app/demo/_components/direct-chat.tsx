'use client'

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp, Keyboard, LayoutGrid, SendHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { demoApi } from '../_lib/api'
import { useDemo } from './demo-context'

/** The OA's Rich Menu (#84): the team's 2000x1349 image, three tap areas. `text` is exactly
 *  what the area sends, the words src/server/chat/menu.ts parses. Areas in % of the image:
 *  the top half is Dashboard, the bottom half is Google Drive (left) and Settings (right). */
const RICH_MENU_IMAGE = '/demo/rich-menu.png'
const AREAS: { text: string; label: string; box: { left: number; top: number; width: number; height: number } }[] = [
  { text: 'Dashboard', label: 'Dashboard', box: { left: 0, top: 0, width: 100, height: 50 } },
  { text: 'เชื่อมต่อ Google Drive', label: 'เชื่อม Google Drive', box: { left: 0, top: 50, width: 50, height: 50 } },
  { text: 'ตั้งค่า', label: 'ตั้งค่า', box: { left: 50, top: 50, width: 50, height: 50 } },
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
    // LINE order: the Rich Menu image sits above the "เมนู" bar, which stays at the bottom.
    <div className="border-t border-black/5 bg-white">
      {open && (
        <div data-rich-menu className="relative border-b border-black/5">
          {/* eslint-disable-next-line @next/next/no-img-element -- a static demo asset at its own size */}
          <img src={RICH_MENU_IMAGE} alt="เมนูน้องจดดี" className="block w-full select-none" draggable={false} />
          {AREAS.map((a) => (
            <button key={a.text} type="button" aria-label={a.label} title={a.label}
              disabled={disabled || sending} onClick={() => void send(a.text)}
              style={{ left: `${a.box.left}%`, top: `${a.box.top}%`, width: `${a.box.width}%`, height: `${a.box.height}%` }}
              className="absolute transition-colors hover:bg-white/10 active:bg-white/20 disabled:cursor-not-allowed" />
          ))}
        </div>
      )}
      <div data-rich-menu-bar className="flex h-11 items-center gap-1 px-2">
        <BarButton label="พิมพ์ข้อความ" onClick={() => setMode('keyboard')}><Keyboard /></BarButton>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg text-[14px] font-semibold text-[#33435C] hover:bg-black/[0.04]">
          เมนู {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
        <span className="size-9 shrink-0" />
      </div>
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
