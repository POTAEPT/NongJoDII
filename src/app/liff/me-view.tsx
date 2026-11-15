'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MyProfile } from '@/server/members/profile'
import { NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX, ROLE_MAX } from '@/server/setup/rules'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Avatar, Button, Field, IconPlus, Notice, Page, StatusScreen, inputClass } from './ui'

// #29 "my info", opened from the welcome reply to a join. `id` is groups.id. The server
// takes the person from the verified LIFF ID token, so a Member edits only their own row.

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้แล้ว'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SAVE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404) return ERR_404
  return fallback
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: MyProfile }

export function MeView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [nicknames, setNicknames] = useState<string[]>([])
  const [role, setRole] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const started = useRef(false)
  const inFlight = useRef(false)

  const fetchProfile = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/me/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, ERR_LOAD) })
      const data = json as MyProfile
      setNicknames(data.nicknames.length > 0 ? data.nicknames : [''])
      setRole(data.role ?? '')
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchProfile()
  }, [fetchProfile])

  const save = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setSaving(true)
    try {
      const { status } = await post('/api/me/save', { idToken, groupId: id, nicknames, role })
      if (status === 200) setSaved(true)
      else setError(errorCopy(status, ERR_SAVE))
    } catch {
      setError(ERR_SAVE)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const close = () => liff.closeWindow()
  const TITLE = 'ข้อมูลของฉัน'
  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchProfile()} onClose={close} />
    )
  }
  if (saved) return <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="บันทึกแล้ว" message="น้องจดดีจะใช้ชื่อเล่นนี้อ่านแชตของกลุ่ม" onClose={close} />

  const { data } = load
  const edit = (f: () => void) => {
    setSaved(false)
    f()
  }
  return (
    <Page
      title={TITLE}
      onBack={close}
      bottom={
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          <Button disabled={saving} onClick={() => void save()}>{saving ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      }
    >
      <section className="flex items-center gap-3 rounded-2xl border border-line bg-page p-4">
        <Avatar name={data.displayName} id={data.displayName} size="md" />
        <div className="min-w-0">
          <p className="truncate font-semibold">{data.displayName}</p>
          <p className="truncate text-xs text-ink-3">ชื่อใน LINE · กลุ่ม {data.groupName ?? 'นี้'}</p>
        </div>
      </section>
      <section className="mt-4 space-y-2">
        <span className="block text-sm font-semibold">ชื่อเล่น (ที่คนในกลุ่มใช้เรียกคุณ)</span>
        <div className="flex flex-wrap gap-2">
          {nicknames.map((n, i) => (
            <span key={i} className="flex items-center rounded-full border border-line bg-page pl-3 pr-1">
              <input
                type="text"
                aria-label="ชื่อเล่น"
                placeholder="ชื่อเล่น"
                maxLength={NICKNAME_MAX}
                className="w-24 bg-transparent py-1 text-sm focus:outline-none"
                value={n}
                disabled={saving}
                onChange={(e) => edit(() => setNicknames(nicknames.map((x, j) => (j === i ? e.target.value : x))))}
              />
              <button
                type="button"
                aria-label="ลบชื่อเล่น"
                className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3"
                disabled={saving}
                onClick={() => edit(() => setNicknames(nicknames.filter((_, j) => j !== i)))}
              >
                ×
              </button>
            </span>
          ))}
          {nicknames.length < NICKNAMES_PER_MEMBER_MAX && (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-sm font-semibold text-primary"
              disabled={saving}
              onClick={() => edit(() => setNicknames([...nicknames, '']))}
            >
              <IconPlus className="h-3.5 w-3.5" /> ชื่อเล่น
            </button>
          )}
        </div>
      </section>
      <div className="mt-4">
        <Field label="หน้าที่">
          <input
            type="text"
            maxLength={ROLE_MAX}
            className={inputClass}
            placeholder="เช่น Design, PM, Dev"
            value={role}
            disabled={saving}
            onChange={(e) => edit(() => setRole(e.target.value))}
          />
        </Field>
      </div>
      <p className="mt-3 text-xs text-ink-3">ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE</p>
    </Page>
  )
}
