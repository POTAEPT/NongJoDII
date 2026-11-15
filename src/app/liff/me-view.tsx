'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MyProfile } from '@/server/members/profile'
import { NICKNAME_MAX, NICKNAMES_PER_MEMBER_MAX, ROLE_MAX } from '@/server/setup/rules'
import { post } from './api'
import type { LiffViewProps } from './liff-sdk'

// #29 "my info", opened from the welcome reply to a join. `id` is groups.id. The server
// takes the person from the verified LIFF ID token, so a Member edits only their own row.

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
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

  if (load.kind === 'loading') return <p className="p-4 text-base">กำลังโหลด...</p>
  if (load.kind === 'error') {
    return (
      <div className="p-4 text-base">
        <p>{load.message}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchProfile()}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  const close = (
    <button type="button" className="mt-4 w-full rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
      กลับไปที่แชท
    </button>
  )
  if (saved) return <div className="p-4 text-base"><p className="font-bold">บันทึกแล้ว ✓</p>{close}</div>

  const { data } = load
  const edit = (f: () => void) => {
    setSaved(false)
    f()
  }
  return (
    <div className="space-y-4 p-4 text-base">
      <h1 className="text-lg font-bold">ข้อมูลของฉันในกลุ่ม {data.groupName ?? 'นี้'}</h1>
      <p className="text-sm">ชื่อ LINE: <span className="font-bold">{data.displayName}</span></p>
      <section className="space-y-2">
        <span className="text-sm">ชื่อเล่น (ที่คนในกลุ่มใช้เรียกคุณ)</span>
        <div className="flex flex-wrap gap-2">
          {nicknames.map((n, i) => (
            <span key={i} className="flex items-center rounded-full border px-2">
              <input
                type="text"
                aria-label="ชื่อเล่น"
                maxLength={NICKNAME_MAX}
                className="w-24 bg-transparent p-1 text-sm"
                value={n}
                disabled={saving}
                onChange={(e) => edit(() => setNicknames(nicknames.map((x, j) => (j === i ? e.target.value : x))))}
              />
              <button
                type="button"
                aria-label="ลบชื่อเล่น"
                className="px-1 text-gray-500"
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
              className="rounded-full border border-dashed px-3 py-1 text-sm text-blue-700"
              disabled={saving}
              onClick={() => edit(() => setNicknames([...nicknames, '']))}
            >
              + ชื่อเล่น
            </button>
          )}
        </div>
      </section>
      <label className="block">
        <span className="text-sm">หน้าที่</span>
        <input
          type="text"
          maxLength={ROLE_MAX}
          className="mt-1 w-full rounded border p-2"
          value={role}
          disabled={saving}
          onChange={(e) => edit(() => setRole(e.target.value))}
        />
      </label>
      <p className="text-xs text-gray-500">ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE</p>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        className="w-full rounded border px-4 py-2 font-bold"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? 'กำลังบันทึก...' : 'บันทึก'}
      </button>
    </div>
  )
}
