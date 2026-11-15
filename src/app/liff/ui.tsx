'use client'

import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { avatarInitial, avatarTone } from './display'

// Shared building blocks of the LIFF pages, following the Figma UI v4 design system
// (App bar, bottom action bar, Button, Field, Avatar, Chip, bottom Sheet, status screens).

// ---------- icons (24px line icons, currentColor) ----------

type IconProps = { className?: string }
const svg = (path: ReactNode) =>
  function Icon({ className = 'h-5 w-5' }: IconProps) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
        strokeLinejoin="round" className={className} aria-hidden="true">
        {path}
      </svg>
    )
  }

export const IconBack = svg(<path d="M15 18l-6-6 6-6" />)
export const IconClose = svg(<path d="M18 6L6 18M6 6l12 12" />)
export const IconCheck = svg(<path d="M20 6L9 17l-5-5" />)
export const IconPlus = svg(<path d="M12 5v14M5 12h14" />)
export const IconCalendar = svg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>)
export const IconClock = svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)
export const IconCloud = svg(<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z" />)
export const IconLock = svg(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>)
export const IconUserOff = svg(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0M3 3l18 18" /></>)

// ---------- page frame ----------

/** Full-height LIFF page: brand app bar, scrolling body, optional bottom bar. */
export function Page({ title, onBack, children, bottom }: {
  title: string; onBack?: () => void; children: ReactNode; bottom?: ReactNode
}) {
  return (
    <div className="liff flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-brand px-2 text-white">
        {onBack ? (
          <button type="button" aria-label="ย้อนกลับ" onClick={onBack}
            className="flex h-10 w-10 items-center justify-center rounded-full active:bg-white/10">
            <IconBack className="h-5 w-5" />
          </button>
        ) : <span className="w-3" />}
        <h1 className="truncate text-base font-semibold">{title}</h1>
      </header>
      <main className="flex-1 px-4 pt-4 pb-6">{children}</main>
      {bottom && (
        <footer className="sticky bottom-0 border-t border-line bg-page px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {bottom}
        </footer>
      )}
    </div>
  )
}

// ---------- buttons ----------

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost'
const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-white active:bg-brand',
  secondary: 'bg-primary-soft text-primary active:bg-line',
  outline: 'border border-line-strong bg-page text-ink active:bg-subtle',
  ghost: 'text-primary active:bg-primary-soft',
}

export function Button({ variant = 'primary', className = '', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button type="button" {...rest}
      className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold transition-colors disabled:opacity-50 ${VARIANT[variant]} ${className}`} />
  )
}

// ---------- form ----------

export const inputClass =
  'w-full rounded-xl border border-line bg-page px-4 py-3 text-base text-ink placeholder:text-ink-3 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-semibold text-ink">{label}</span>
      {children}
    </label>
  )
}

// ---------- people and chips ----------

export function Avatar({ name, id, size = 'sm' }: { name: string; id: string; size?: 'sm' | 'md' }) {
  const dim = size === 'md' ? 'h-9 w-9 text-sm' : 'h-6 w-6 text-xs'
  return (
    <span aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${dim} ${avatarTone(id)}`}>
      {avatarInitial(name)}
    </span>
  )
}

type Tone = 'neutral' | 'warn' | 'done' | 'dashed'
const TONE: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink',
  warn: 'bg-warn-bg text-warn',
  done: 'bg-done-bg text-done',
  dashed: 'border border-dashed border-line-strong text-primary',
}

export function Chip({ tone = 'neutral', icon, children, onClick, disabled, label }: {
  tone?: Tone; icon?: ReactNode; children: ReactNode; onClick?: () => void; disabled?: boolean; label?: string
}) {
  const cls = `inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`
  if (!onClick) return <span className={cls}>{icon}<span className="truncate">{children}</span></span>
  return (
    <button type="button" aria-label={label} className={`${cls} disabled:opacity-60`} onClick={onClick} disabled={disabled}>
      {icon}<span className="truncate">{children}</span>
    </button>
  )
}

/** Chip that shows a Task's assignee, or "+ ผู้รับ" when there is none. */
export function AssigneeChip({ member, onClick, disabled }: {
  member: { lineUserId: string; displayName: string } | undefined; onClick?: () => void; disabled?: boolean
}) {
  if (!member) {
    return <Chip tone="dashed" label="เลือกผู้รับ" icon={<IconPlus className="h-3.5 w-3.5" />} onClick={onClick} disabled={disabled}>ผู้รับ</Chip>
  }
  return (
    <Chip label={`ผู้รับ ${member.displayName} (เปลี่ยน)`} icon={<Avatar name={member.displayName} id={member.lineUserId} />} onClick={onClick} disabled={disabled}>
      {member.displayName}
    </Chip>
  )
}

export function DueChip({ label }: { label: string | null }) {
  if (!label) return <Chip tone="warn" icon={<IconCalendar className="h-3.5 w-3.5" />}>ยังไม่กำหนด</Chip>
  return <Chip icon={<IconCalendar className="h-3.5 w-3.5" />}>{label}</Chip>
}

// ---------- assignee bottom sheet ----------

export type Member = { lineUserId: string; displayName: string }

/** Bottom sheet to pick one assignee (or none). The pick applies on "ยืนยัน". */
export function AssigneeSheet({ open, subtitle, members, value, onClose, onConfirm }: {
  open: boolean; subtitle?: string; members: Member[]; value: string
  onClose: () => void; onConfirm: (lineUserId: string) => void
}) {
  const [picked, setPicked] = useState(value)
  // Each opening starts from the current assignee.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setPicked(value)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const options: { id: string; name: string | null }[] = [
    ...members.map((m) => ({ id: m.lineUserId, name: m.displayName })),
    { id: '', name: null },
  ]
  return (
    <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="เลือกผู้รับ"
        className="liff max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl bg-page px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">เลือกผู้รับ</h2>
          <button type="button" aria-label="ปิด" onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full text-ink-2 active:bg-subtle">
            <IconClose />
          </button>
        </div>
        {subtitle && <p className="mt-1 truncate text-sm text-ink-2">{subtitle}</p>}
        <ul className="mt-4 space-y-2">
          {options.map((o) => {
            const on = picked === o.id
            return (
              <li key={o.id || 'none'}>
                <button type="button" aria-pressed={on} onClick={() => setPicked(o.id)}
                  className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${on ? 'border-primary bg-primary-soft/60' : 'border-line bg-page'}`}>
                  {o.name !== null
                    ? <Avatar name={o.name} id={o.id} size="md" />
                    : <span className="flex h-9 w-9 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-3"><IconPlus className="h-4 w-4" /></span>}
                  <span className="min-w-0 flex-1 truncate text-base font-semibold">{o.name ?? 'ยังไม่มีผู้รับ'}</span>
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-primary bg-primary text-white' : 'border-line-strong'}`}>
                    {on && <IconCheck className="h-4 w-4" />}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <Button className="mt-4" onClick={() => onConfirm(picked)}>ยืนยัน</Button>
      </div>
    </div>
  )
}

// ---------- status screens ----------

export function Spinner() {
  return <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-line border-t-primary" aria-hidden="true" />
}

export const IconRetry = svg(<><path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4" /></>)

/** Whole-page loading, error or refusal state (Figma #17-2 / #17-3). With `appTitle`
 *  it sits under the app bar like the other screens. */
export function StatusScreen({ kind, appTitle, onBack, title, message, onRetry, onClose }: {
  kind: 'loading' | 'error' | 'forbidden' | 'done'
  appTitle?: string; onBack?: () => void
  title?: string; message?: string; onRetry?: () => void; onClose?: () => void
}) {
  const icon = {
    loading: <Spinner />,
    error: <IconRetry className="h-7 w-7" />,
    forbidden: <IconUserOff className="h-7 w-7" />,
    done: <IconCheck className="h-7 w-7" />,
  }[kind]
  const ring = {
    loading: 'bg-page',
    error: 'bg-danger-bg text-danger',
    forbidden: 'bg-primary-soft text-primary',
    done: 'bg-done-bg text-done',
  }[kind]
  const body = (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center text-center" role={kind === 'loading' ? 'status' : undefined}>
      <span className={`flex h-16 w-16 items-center justify-center rounded-full ${ring}`}>{icon}</span>
      {title && <p className="mt-4 text-lg font-semibold">{title}</p>}
      {message && <p className="mt-2 text-sm text-ink-2">{message}</p>}
      {(onRetry || onClose) && (
        <div className="mt-6 w-full space-y-1">
          {onRetry && <Button onClick={onRetry}>ลองใหม่</Button>}
          {onClose && <Button variant="ghost" onClick={onClose}>กลับไปที่แชต</Button>}
        </div>
      )}
    </div>
  )
  if (appTitle) return <Page title={appTitle} onBack={onBack}>{body}</Page>
  return <div className="liff min-h-dvh px-4">{body}</div>
}

/** Small inline banner for form errors and notices. */
export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const cls = { error: 'bg-danger-bg text-danger', info: 'bg-warn-bg text-warn', success: 'bg-done-bg text-done' }[tone]
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-xl px-3 py-2 text-sm ${cls}`}>{children}</p>
}
