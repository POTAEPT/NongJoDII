'use client'

import { useMemo, type MouseEvent } from 'react'
import type { Liff } from '@line/liff'
import { cn } from 'cn'
import { X } from 'lucide-react'
import { setApiBase } from '@/app/liff/api'
import { LiffView } from '@/app/liff/liff-app'
import type { LiffParams } from '@/app/liff/params'
import { parseDemoLiff, type LiffTarget } from './demo-context'

// The LIFF views run in the demo against /demo/api (same paths, demo deps). Set once, when
// this module loads; the live /liff page never imports it.
setApiBase('/demo/api')

const VIEW_TITLE: Record<string, string> = {
  review: 'ตรวจงานจากสรุป', task: 'รายละเอียดงาน', progress: 'อัปเดตงาน', dashboard: 'Dashboard',
  setup: 'ตั้งค่ากลุ่ม', owner: 'เจ้าของบอท', me: 'ข้อมูลของฉัน', settings: 'ตั้งค่า', takeover: 'รับเป็นเจ้าของบอท',
  google: 'เชื่อม Google Drive',
}

const KNOWN = new Set(Object.keys(VIEW_TITLE))

/** LINE's LIFF window, inside the phone: a full-height sheet over the chat. */
export function LiffDrawer({ target, lineUserId, onNavigate, onClose }: {
  target: LiffTarget | null
  lineUserId: string | null
  onNavigate: (t: LiffTarget) => void
  onClose: () => void
}) {
  const open = target !== null && lineUserId !== null
  const idToken = lineUserId ? `demo:${lineUserId}` : ''

  // The stub of the LIFF SDK the views use: closeWindow, openWindow, isInClient, getIDToken.
  const liff = useMemo(() => ({
    closeWindow: () => onClose(),
    openWindow: ({ url }: { url: string; external?: boolean }) => {
      const t = parseDemoLiff(url)
      if (t) onNavigate(t)
      else window.open(url, '_blank', 'noopener')
    },
    isInClient: () => true,
    isLoggedIn: () => true,
    getIDToken: () => idToken,
    getOS: () => 'web',
    getContext: () => null,
  }) as unknown as Liff, [idToken, onClose, onNavigate])

  // Links inside the views: demo LIFF links switch the view; other sites open a new tab.
  const onClickCapture = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') ?? ''
    const t = parseDemoLiff(href)
    if (t) {
      e.preventDefault()
      onNavigate(t)
      return
    }
    if (/^https?:\/\//.test(href) && !href.startsWith(window.location.origin)) {
      e.preventDefault()
      window.open(href, '_blank', 'noopener')
    }
  }

  const params: LiffParams | null = target && KNOWN.has(target.view)
    ? { view: target.view as NonNullable<LiffParams['view']>, id: target.id }
    : target ? { view: null, id: null } : null

  return (
    <div aria-hidden={!open}
      className={cn('absolute inset-0 z-30 flex flex-col transition-[visibility] duration-300', open ? 'visible' : 'invisible')}>
      <div onClick={onClose}
        className={cn('absolute inset-0 bg-black/40 transition-opacity duration-300', open ? 'opacity-100' : 'opacity-0')} />
      <div role="dialog" aria-label={target ? VIEW_TITLE[target.view] ?? 'LIFF' : 'LIFF'}
        className={cn(
          'relative mt-auto flex h-[94%] flex-col overflow-hidden rounded-t-[22px] bg-white shadow-2xl transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 bg-white px-3">
          <button type="button" onClick={onClose} aria-label="ปิด"
            className="flex size-9 items-center justify-center rounded-full text-[#33435C] hover:bg-black/5"><X className="size-5" /></button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-[14px] font-semibold text-[#1E1E1E]">{target ? VIEW_TITLE[target.view] ?? 'น้องจดดี' : ''}</p>
            <p className="truncate text-[10px] text-[#8A94A6]">liff.line.me · น้องจดดี</p>
          </div>
          <span className="size-9" />
        </div>
        {/* transform: fixed-position parts of the views stay inside the phone. */}
        <div onClickCapture={onClickCapture}
          className="demo-liff demo-scroll relative flex-1 transform-gpu overflow-y-auto bg-[#F4F6F9]">
          {open && params && (
            <LiffView key={`${target?.view}:${target?.id}:${lineUserId}`} params={params}
              props={{ liff, idToken, liffId: 'demo-liff' }} />
          )}
        </div>
      </div>
    </div>
  )
}
