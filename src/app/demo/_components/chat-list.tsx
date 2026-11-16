'use client'

import { MessageCirclePlus, Search, Settings } from 'lucide-react'
import { cn } from 'cn'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import type { DemoDirectInfo, DemoGroupInfo } from '../_lib/api'
import { bangkokDate, timeLabel } from '../_lib/time'
import { BotAvatar } from './avatars'
import { initialOf, personaTone } from './demo-context'

export const DIRECT_CHAT_NAME = 'NongJoDII (แชตส่วนตัว)'

type Row = { kind: 'group'; g: DemoGroupInfo; at: string } | { kind: 'direct'; d: DemoDirectInfo; at: string }

/** LINE's chat list inside the phone: one row per group plus the bot's 1:1 chat with "me"
 *  (`direct`, shown even when empty), newest first, with the last message, its time and an
 *  unread badge. Tapping a row opens that chat. */
export function ChatList({ groups, direct, now, onOpen, onOpenDirect }: {
  groups: DemoGroupInfo[]; direct: DemoDirectInfo | null; now: string | null
  onOpen: (lineGroupId: string) => void; onOpenDirect: () => void
}) {
  const rows: Row[] = [
    ...groups.map((g): Row => ({ kind: 'group', g, at: g.lastMessage?.at ?? '' })),
    ...(direct ? [{ kind: 'direct', d: direct, at: direct.lastMessage?.at ?? '' } as Row] : []),
  ]
  const sorted = rows.sort((a, b) => b.at.localeCompare(a.at))
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between px-4 text-[#1E1E1E]">
        <p className="text-[22px] font-bold">แชต</p>
        <span className="flex items-center gap-4 [&_svg]:size-[21px]"><Search /><MessageCirclePlus /><Settings /></span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sorted.map((r) => r.kind === 'direct' ? (
          <button key="direct" type="button" onClick={onOpenDirect}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-black/[0.03] active:bg-black/[0.06]">
            <BotAvatar className="size-12" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[#1E1E1E]">{DIRECT_CHAT_NAME}</p>
                <span className="shrink-0 text-[11px] text-[#8A94A6] tabular-nums">{r.d.lastMessage ? listTime(r.d.lastMessage.at, now) : ''}</span>
              </div>
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] text-[#6B778A]">{r.d.lastMessage?.text ?? 'ยังไม่มีข้อความ'}</p>
                <UnreadBadge n={r.d.unread} />
              </div>
            </div>
          </button>
        ) : (
          <GroupRow key={r.g.lineGroupId} g={r.g} now={now} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}

function UnreadBadge({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <Badge className="h-5 min-w-5 shrink-0 justify-center rounded-full bg-(--line-green) px-1.5 text-[11px] text-white tabular-nums">
      {n > 99 ? '99+' : n}
    </Badge>
  )
}

function GroupRow({ g, now, onOpen }: { g: DemoGroupInfo; now: string | null; onOpen: (lineGroupId: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(g.lineGroupId)}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-black/[0.03] active:bg-black/[0.06]">
      <GroupAvatar lineGroupId={g.lineGroupId} name={g.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[15px] font-semibold text-[#1E1E1E]">
            {g.name} <span className="font-normal text-[#8A94A6]">({g.members})</span>
          </p>
          <span className="shrink-0 text-[11px] text-[#8A94A6] tabular-nums">{g.lastMessage ? listTime(g.lastMessage.at, now) : ''}</span>
        </div>
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] text-[#6B778A]">{g.lastMessage?.text ?? ' '}</p>
          <UnreadBadge n={g.unread} />
        </div>
        {g.projectName && (
          <p className="truncate text-[11px] text-[#8A94A6]">
            {g.isSubGroup ? `Sub group ของ ${g.projectName}` : 'กลุ่มหลักของโปรเจกต์'}
          </p>
        )}
      </div>
    </button>
  )
}

function GroupAvatar({ lineGroupId, name }: { lineGroupId: string; name: string }) {
  const tone = personaTone(lineGroupId)
  return (
    <Avatar className={cn('size-12 after:hidden')}>
      <AvatarFallback style={{ backgroundColor: tone.bg, color: tone.fg }} className="text-[18px] font-semibold">
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}

/** Today: '14:05'; otherwise the Bangkok date as 'D/M'. */
function listTime(at: string, now: string | null): string {
  if (!now || bangkokDate(at) === bangkokDate(now)) return timeLabel(at)
  const [, m, d] = bangkokDate(at).split('-')
  return `${Number(d)}/${Number(m)}`
}
