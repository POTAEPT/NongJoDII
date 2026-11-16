'use client'

import Image from 'next/image'
import { cn } from 'cn'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { initialOf, personaTone } from './demo-context'

export function PersonaAvatar({ personaKey, name, className }: { personaKey: string; name: string; className?: string }) {
  const tone = personaTone(personaKey)
  return (
    <Avatar className={cn('size-9 after:hidden', className)}>
      <AvatarFallback style={{ backgroundColor: tone.bg, color: tone.fg }} className="font-semibold">
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}

export function BotAvatar({ className }: { className?: string }) {
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white ring-1 ring-black/5', className)}>
      <Image src="/logo.svg" alt="" width={28} height={28} unoptimized />
    </span>
  )
}

export const BOT_NAME = 'NongJoDII'
