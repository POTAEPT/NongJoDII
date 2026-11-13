'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupLoad } from '@/server/setup/types'
import type { LiffViewProps } from './liff-sdk'

// #52 Owner confirm, opened from the #2e card. `id` is groups.id. The server takes the
// person from the verified LIFF ID token; only the nominee may confirm.

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงยืนยันไม่ได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_NOT_NOMINEE = 'เฉพาะคนที่ถูกเลือกเป็นเจ้าของบอทเท่านั้นที่กดยืนยันได้'
const ERR_CLOSED = 'กลุ่มนี้มีเจ้าของบอทแล้ว หรือมีการเปลี่ยนเจ้าของบอท'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'ยืนยันไม่สำเร็จ กรุณาลองใหม่'

async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  if (res.status === 200 || res.status === 403) json = await res.json()
  return { status: res.status, json }
}

function errorCopy(status: number, json: unknown, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return (json as { error?: string } | null)?.error === 'not_nominee' ? ERR_NOT_NOMINEE : ERR_403
  if (status === 404) return ERR_404
  if (status === 409) return ERR_CLOSED
  return fallback
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SetupLoad }

export function OwnerView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const started = useRef(false)
  const inFlight = useRef(false)

  const fetchGroup = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/setup/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, json, ERR_LOAD) })
      setLoad({ kind: 'ready', data: json as SetupLoad })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchGroup()
  }, [fetchGroup])

  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/setup/confirm-owner', { idToken, groupId: id })
      if (status === 200) setConfirmed(true)
      else setError(errorCopy(status, json, ERR_SUBMIT))
    } catch {
      setError(ERR_SUBMIT)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  if (load.kind === 'loading') return <p className="p-4 text-base">กำลังโหลด...</p>
  if (load.kind === 'error') {
    return (
      <div className="p-4 text-base">
        <p>{load.message}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchGroup()}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  const { data } = load
  const close = (
    <button type="button" className="mt-4 w-full rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
      กลับไปที่แชท
    </button>
  )
  const isNominee = data.nominee?.lineUserId === data.requesterLineUserId
  if (confirmed || (data.state === 'confirmed' && isNominee)) {
    return <div className="p-4 text-base"><p className="font-bold">คุณเป็นเจ้าของบอทของกลุ่มนี้แล้ว ✓</p>{close}</div>
  }
  if (data.state === 'confirmed' || data.state === 'in_project') return <div className="p-4 text-base"><p>{ERR_CLOSED}</p>{close}</div>
  if (!isNominee) return <div className="p-4 text-base"><p>{ERR_NOT_NOMINEE}</p>{close}</div>

  return (
    <div className="p-4 text-base">
      <h1 className="text-lg font-bold">ยืนยันเป็นเจ้าของบอทของกลุ่ม {data.groupName ?? 'นี้'}</h1>
      <p className="mt-2 text-sm text-gray-600">
        เจ้าของบอทดูแลการตั้งค่าของกลุ่ม และเชื่อม Google Drive ของตัวเองเพื่อเก็บไฟล์ของกลุ่ม
      </p>
      {error && <p role="alert" className="mt-4">{error}</p>}
      <button
        type="button"
        className="mt-4 w-full rounded border px-4 py-2 font-bold"
        disabled={submitting}
        onClick={() => void confirm()}
      >
        {submitting ? 'กำลังยืนยัน...' : 'ยืนยัน'}
      </button>
    </div>
  )
}
