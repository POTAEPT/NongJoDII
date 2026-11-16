'use client'

import type { ReactNode } from 'react'
import { BatteryFull, ChevronLeft, Menu, Phone, Search, SignalHigh, Wifi } from 'lucide-react'
import { timeLabel } from '../_lib/time'

/** An iPhone-sized frame (393 x 852, scaled down to fit the window height). */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative shrink-0 rounded-[58px] bg-[#16181D] p-[11px] shadow-[0_30px_80px_-20px_rgba(18,41,77,0.45),inset_0_0_0_2px_#3A3F48]"
      style={{ height: 'min(852px, calc(100dvh - 48px))', aspectRatio: '393 / 852' }}>
      {/* transform: the frame is the containing block for anything fixed inside it. */}
      <div className="relative flex h-full w-full transform-gpu flex-col overflow-hidden rounded-[47px] bg-white">
        {children}
      </div>
    </div>
  )
}

export function StatusBar({ now }: { now: string | null }) {
  return (
    <div className="relative flex h-11 shrink-0 items-center justify-between bg-white px-7 pt-1 text-[15px] font-semibold text-black">
      <span className="tabular-nums">{now ? timeLabel(now) : '--:--'}</span>
      <span className="absolute top-2 left-1/2 h-[30px] w-[118px] -translate-x-1/2 rounded-full bg-black" />
      <span className="flex items-center gap-1 [&_svg]:size-[17px]"><SignalHigh /><Wifi /><BatteryFull /></span>
    </div>
  )
}

/** The open chat's header. The back arrow opens the chat list; `unread` counts the other
 *  chats' unread messages, as LINE shows next to its back arrow. No `members`: a 1:1 chat. */
export function ChatHeader({ name, members, unread = 0, onBack }: { name: string; members?: number; unread?: number; onBack?: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-black/5 bg-white px-2 text-[#1E1E1E]">
      <button type="button" onClick={onBack} aria-label="กลับไปที่รายการแชต" className="flex shrink-0 items-center rounded-full pr-1 hover:bg-black/5">
        <ChevronLeft className="size-7" />
        {unread > 0 && <span className="text-[14px] font-semibold tabular-nums">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[16px] font-semibold">{name}{members !== undefined && <> <span className="font-normal text-[#6B778A]">({members})</span></>}</p>
      </div>
      <span className="flex items-center gap-3.5 pr-1.5 [&_svg]:size-[21px]"><Search /><Phone /><Menu /></span>
    </div>
  )
}
