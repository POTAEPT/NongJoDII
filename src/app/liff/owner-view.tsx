'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SetupLoad } from '@/server/setup/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Button, IconLock, Notice, Page, StatusScreen } from './ui'

// #52 Owner confirm, opened from the #2e card. `id` is groups.id. The server takes the
// person from the verified LIFF ID token; only the nominee may confirm.

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงยืนยันไม่ได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_NOT_NOMINEE = 'เฉพาะคนที่ถูกเลือกเป็นเจ้าของบอทเท่านั้นที่กดยืนยันได้'
const ERR_CLOSED = 'กลุ่มนี้มีเจ้าของบอทแล้ว หรือมีการเปลี่ยนเจ้าของบอท'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'ยืนยันไม่สำเร็จ กรุณาลองใหม่'

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

  const close = () => liff.closeWindow()
  const TITLE = 'ยืนยันเจ้าของบอท'
  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchGroup()} onClose={close} />
    )
  }
  const { data } = load
  const isNominee = data.nominee?.lineUserId === data.requesterLineUserId
  if (confirmed || (data.state === 'confirmed' && isNominee)) {
    return <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="คุณเป็นเจ้าของบอทแล้ว" message={`ของกลุ่ม ${data.groupName ?? 'นี้'}`} onClose={close} />
  }
  if (data.state === 'confirmed' || data.state === 'in_project') {
    return <StatusScreen kind="forbidden" appTitle={TITLE} onBack={close} title="ยืนยันไม่ได้" message={ERR_CLOSED} onClose={close} />
  }
  if (!isNominee) {
    return <StatusScreen kind="forbidden" appTitle={TITLE} onBack={close} title="ยืนยันไม่ได้" message={ERR_NOT_NOMINEE} onClose={close} />
  }

  return (
    <Page
      title={TITLE}
      onBack={close}
      bottom={
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          <Button disabled={submitting} onClick={() => void confirm()}>{submitting ? 'กำลังยืนยัน...' : 'ยืนยันเป็นเจ้าของบอท'}</Button>
        </div>
      }
    >
      <div className="flex flex-col items-center pt-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconLock className="h-7 w-7" /></span>
        <h2 className="mt-4 text-[22px] font-semibold leading-snug">ยืนยันเป็นเจ้าของบอทของกลุ่ม {data.groupName ?? 'นี้'}</h2>
        <p className="mt-2 text-sm text-ink-2">
          เจ้าของบอทดูแลการตั้งค่าของกลุ่ม และเชื่อม Google Drive ของตัวเองเพื่อเก็บไฟล์ของกลุ่ม
        </p>
      </div>
    </Page>
  )
}
