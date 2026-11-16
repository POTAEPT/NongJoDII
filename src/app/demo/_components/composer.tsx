'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from 'cn'
import { AtSign, FileUp, ImageIcon, SendHorizontal, Smile, X } from 'lucide-react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { demoApi, fileToBase64 } from '../_lib/api'
import { BOT_NAME, BotAvatar, PersonaAvatar } from './avatars'
import { useDemo } from './demo-context'
import { previewText, type ThreadItem } from './chat-thread'

/** Who is typing: the selected persona is "me". allowAll: anyone may be picked (the 1:1
 *  chat), not only the people in the selected group. */
export function SenderSwitcher({ selected, onSelect, allowAll = false }: {
  selected: string | null; onSelect: (key: string) => void; allowAll?: boolean
}) {
  const { state } = useDemo()
  const personas = state?.personas ?? []
  return (
    <div className="flex items-center gap-2 border-t border-black/5 bg-[#F7F8FA] px-3 py-2">
      <span className="shrink-0 text-[11px] font-medium text-[#6B778A]">ส่งในชื่อ</span>
      <div className="demo-scroll flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
        {personas.map((p) => {
          const on = p.key === selected
          const can = allowAll || p.inGroup
          return (
            <button key={p.key} type="button" onClick={() => onSelect(p.key)} disabled={!can}
              title={can ? p.lineName : `${p.lineName} ไม่ได้อยู่ในกลุ่ม`}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[13px] font-medium transition-colors',
                on ? 'border-(--line-green) bg-(--line-green) text-white' : 'border-[#DCE1E8] bg-white text-[#33435C] hover:bg-[#EEF2F6]',
                !can && 'opacity-40',
              )}>
              <PersonaAvatar personaKey={p.key} name={p.lineName} className="size-6 text-[11px]" />
              {p.lineName}
            </button>
          )
        })}
      </div>
    </div>
  )
}

type MentionOption = { key: string | null; name: string }

export function Composer({ replyTo, onCancelReply, onSent }: {
  replyTo: ThreadItem | null
  onCancelReply: () => void
  onSent: () => void
}) {
  const { me, state, personaName } = useDemo()
  const [text, setText] = useState('')
  const [mentions, setMentions] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const disabled = !me || !me.inGroup

  const mentionOptions: MentionOption[] = [
    ...(state?.group.botInGroup ? [{ key: null, name: BOT_NAME }] : []),
    ...(state?.personas.filter((p) => p.inGroup && p.key !== me?.key).map((p) => ({ key: p.key, name: p.lineName })) ?? []),
  ]
  const query = mentionOpen ? (/@([^\s@]*)$/.exec(text)?.[1] ?? '') : ''
  const shown = mentionOptions.filter((o) => o.name.toLowerCase().startsWith(query.toLowerCase()))

  const run = async (fn: () => Promise<unknown>) => {
    setSending(true)
    try {
      await fn()
      onSent()
    } catch (e) {
      toast.error(`ส่งไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }

  const sendText = () => {
    const t = text.trim()
    if (!me || !t || sending) return
    const keys = mentions.filter((k) => {
      const p = state?.personas.find((x) => x.key === k)
      return p && t.includes(`@${p.lineName}`)
    })
    const quotedMessageId = replyTo?.messageId
    setText('')
    setMentions([])
    setMentionOpen(false)
    onCancelReply()
    void run(() => demoApi.sendText(me.key, t, {
      ...(quotedMessageId ? { quotedMessageId } : {}),
      ...(keys.length ? { mentions: keys } : {}),
    }))
  }

  const pickMention = (o: MentionOption) => {
    setText((t) => t.replace(/@([^\s@]*)$/, `@${o.name} `))
    if (o.key) setMentions((m) => (m.includes(o.key as string) ? m : [...m, o.key as string]))
    setMentionOpen(false)
    input.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (mentionOpen && shown.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault()
      pickMention(shown[0])
      return
    }
    if (e.key === 'Escape') setMentionOpen(false)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendText()
    }
  }

  const onImages = async (files: FileList | null) => {
    if (!me || !files || files.length === 0) return
    const list = Array.from(files)
    const setId = list.length > 1 ? `set${Date.now().toString(36)}` : null
    await run(async () => {
      for (const [i, f] of list.entries()) {
        const dataBase64 = await fileToBase64(f)
        await demoApi.sendImage(me.key, { fileName: f.name, contentType: f.type || 'image/jpeg', dataBase64 },
          setId ? { id: setId, index: i + 1, total: list.length } : undefined)
      }
    })
  }

  const onFile = async (files: FileList | null) => {
    const f = files?.[0]
    if (!me || !f) return
    await run(async () => {
      const dataBase64 = await fileToBase64(f)
      await demoApi.sendFile(me.key, { fileName: f.name, contentType: f.type || 'application/octet-stream', dataBase64 })
    })
  }

  return (
    <div className="relative bg-white">
      {replyTo && (
        <div className="flex items-center gap-2 border-t border-black/5 bg-[#F2F5F9] px-3 py-2">
          <div className="min-w-0 flex-1 border-l-[3px] border-(--line-green) pl-2">
            <p className="text-[12px] font-semibold text-[#33435C]">ตอบกลับ {replyTo.from === 'bot' ? BOT_NAME : personaName(replyTo.persona)}</p>
            <p className="truncate text-[12px] text-[#6B778A]">{previewText(replyTo.message)}</p>
          </div>
          <button type="button" onClick={onCancelReply} aria-label="ยกเลิกการตอบกลับ"
            className="rounded-full p-1 text-[#6B778A] hover:bg-black/5"><X className="size-4" /></button>
        </div>
      )}

      {mentionOpen && shown.length > 0 && (
        <div className="absolute right-3 bottom-full left-3 mb-1 overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-black/10">
          {shown.map((o) => (
            <button key={o.key ?? 'bot'} type="button" onClick={() => pickMention(o)}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[14px] hover:bg-[#F2F5F9]">
              {o.key ? <PersonaAvatar personaKey={o.key} name={o.name} className="size-7" /> : <BotAvatar className="size-7" />}
              <span className="font-medium">{o.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1 border-t border-black/5 px-2 py-2">
        <IconAction label="ส่งรูป (เลือกได้หลายรูป)" disabled={disabled || sending} onClick={() => imageInput.current?.click()}><ImageIcon /></IconAction>
        <IconAction label="ส่งไฟล์" disabled={disabled || sending} onClick={() => fileInput.current?.click()}><FileUp /></IconAction>
        <IconAction label="แท็กคน (@)" disabled={disabled} onClick={() => {
          setText((t) => (t && !t.endsWith(' ') ? `${t} @` : `${t}@`))
          setMentionOpen(true)
          input.current?.focus()
        }}><AtSign /></IconAction>
        <div className="flex min-h-10 min-w-0 flex-1 items-center rounded-[20px] bg-[#EFF1F4] pr-1 pl-3.5">
          <textarea ref={input} rows={1} value={text} disabled={disabled}
            placeholder={disabled ? 'เลือกคนที่อยู่ในกลุ่ม' : 'Aa'}
            onChange={(e) => {
              const v = e.target.value
              setText(v)
              setMentionOpen(/(^|\s)@[^\s@]*$/.test(v))
            }}
            onKeyDown={onKeyDown}
            className="max-h-24 min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 outline-none placeholder:text-[#9AA4B2] field-sizing-content" />
          <IconAction label="ส่งสติกเกอร์" disabled={disabled || sending}
            onClick={() => me && void run(() => demoApi.sendSticker(me.key))}><Smile /></IconAction>
        </div>
        <button type="button" onClick={sendText} disabled={disabled || sending || !text.trim()} aria-label="ส่ง"
          className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-(--line-green) text-white transition-opacity disabled:opacity-30">
          <SendHorizontal className="size-[18px]" />
        </button>
      </div>
      <input ref={imageInput} type="file" accept="image/*" multiple hidden
        onChange={(e) => { void onImages(e.target.files); e.target.value = '' }} />
      <input ref={fileInput} type="file" hidden
        onChange={(e) => { void onFile(e.target.files); e.target.value = '' }} />
    </div>
  )
}

function IconAction({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={label} onClick={onClick} disabled={disabled}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-[#4A5568] hover:bg-black/5 disabled:opacity-30 [&_svg]:size-[22px]">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}
