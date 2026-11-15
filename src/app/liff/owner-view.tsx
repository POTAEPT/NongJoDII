'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { liffUrl } from '@/server/liff-links'
import type { OwnerConfirmResult, SetupLoad } from '@/server/setup/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Button, IconLock, Notice, Page, StatusScreen } from './ui'

// #52 Owner confirm, opened from the #2e card. `id` is groups.id. The server takes the
// person from the verified LIFF ID token; only the nominee may confirm.
// #30: opened from the owner_needed card of a group whose Owner left (ownerNeeded). The first
// live Member to press takes the role; it takes effect once they connect Google Drive.

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงยืนยันไม่ได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_NOT_NOMINEE = 'เฉพาะคนที่ถูกเลือกเป็นเจ้าของบอทเท่านั้นที่กดยืนยันได้'
const ERR_CLOSED = 'กลุ่มนี้มีเจ้าของบอทแล้ว หรือมีการเปลี่ยนเจ้าของบอท'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'ยืนยันไม่สำเร็จ กรุณาลองใหม่'
const ERR_TAKEN = 'มีสมาชิกคนอื่นรับเป็นเจ้าของบอทคนใหม่แล้ว'
const ERR_SUB_GROUP = 'กลุ่มย่อยใช้เจ้าของบอทคนเดียวกับกลุ่มหลักของโปรเจกต์ จึงเปลี่ยนเจ้าของบอทที่กลุ่มนี้ไม่ได้'

function errorCopy(status: number, json: unknown, fallback: string, ownerNeeded = false): string {
  const code = (json as { error?: string } | null)?.error
  if (status === 401) return ERR_401
  if (status === 403) return code === 'not_nominee' ? (ownerNeeded ? ERR_TAKEN : ERR_NOT_NOMINEE) : ERR_403
  if (status === 404) return ERR_404
  if (status === 409) return code === 'sub_group' ? ERR_SUB_GROUP : ERR_CLOSED
  return fallback
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SetupLoad }

export function OwnerView({ liff, idToken, liffId, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [needsDrive, setNeedsDrive] = useState(false)
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
      const ownerNeeded = load.kind === 'ready' && load.data.ownerNeeded
      if (status === 200 && (json as OwnerConfirmResult).state === 'needs_drive') setNeedsDrive(true)
      else if (status === 200) setConfirmed(true)
      else setError(errorCopy(status, json, ERR_SUBMIT, ownerNeeded))
    } catch {
      setError(ERR_SUBMIT)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const close = () => liff.closeWindow()

  // #30: take the role over, then connect Google Drive (the LIFF Google view starts the
  // sign-in; the Google callback finishes the change).
  function ownerNeededPage() {
    const groupName = load.kind === 'ready' ? load.data.groupName ?? 'นี้' : 'นี้'
    if (needsDrive) {
      return (
        <Page
          title={TITLE}
          onBack={close}
          bottom={
            <a className="flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-base font-semibold text-white"
              href={liffUrl(liffId, 'google')}>เชื่อม Google Drive</a>
          }
        >
          <div className="flex flex-col items-center pt-6 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconLock className="h-7 w-7" /></span>
            <h2 className="mt-4 text-[22px] font-semibold leading-snug">อีกขั้นเดียว เชื่อม Google Drive ของคุณ</h2>
            <p className="mt-2 text-sm text-ink-2">
              คุณจะเป็นเจ้าของบอทของกลุ่ม {groupName} เมื่อเชื่อม Google Drive ของตัวเองแล้ว ไฟล์เดิมยังอยู่ใน Drive ของเจ้าของบอทคนก่อน
            </p>
          </div>
        </Page>
      )
    }
    return (
      <Page
        title={TITLE}
        onBack={close}
        bottom={
          <div className="space-y-2">
            {error && <Notice>{error}</Notice>}
            <Button disabled={submitting} onClick={() => void confirm()}>{submitting ? 'กำลังยืนยัน...' : 'เป็นเจ้าของบอทแทน'}</Button>
          </div>
        }
      >
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconLock className="h-7 w-7" /></span>
          <h2 className="mt-4 text-[22px] font-semibold leading-snug">เป็นเจ้าของบอทคนใหม่ของกลุ่ม {groupName}</h2>
          <p className="mt-2 text-sm text-ink-2">
            เจ้าของบอทคนเดิมออกจากกลุ่มแล้ว การเก็บไฟล์และสรุปรายสัปดาห์จึงหยุดไว้ก่อน เจ้าของบอทคนใหม่ยืนยันด้วย LINE แล้วเชื่อม Google Drive ของตัวเอง
          </p>
        </div>
      </Page>
    )
  }
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
  if (data.ownerNeeded && !confirmed) return ownerNeededPage()
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
