'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TakeoverAnswerResult, TakeoverChoice, TakeoverLoad } from '@/server/owner-change/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Button, Notice, Page, StatusScreen } from './ui'

// #31 The Sub group take-over question, opened from the main group's card after an Owner
// change. `id` is the main group's groups.id. The server takes the person from the
// verified LIFF ID token; only the Project's new Owner may answer.

const TITLE = 'ดูแลกลุ่มย่อยต่อไหม'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงตอบไม่ได้'
const ERR_NOT_OWNER = 'เฉพาะเจ้าของบอทคนใหม่ของโปรเจกต์เท่านั้นที่ตอบได้'
const ERR_404 = 'ไม่พบโปรเจกต์ของกลุ่มนี้'
const ERR_CHANGED = 'กลุ่มย่อยเปลี่ยนไประหว่างบันทึก กรุณาดูอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'บันทึกคำตอบไม่สำเร็จ กรุณาลองใหม่'
const SUB_GROUP = 'กลุ่มย่อย'

function errorCopy(status: number, json: unknown, fallback: string): string {
  const code = (json as { error?: string } | null)?.error
  if (status === 401) return ERR_401
  if (status === 403) return code === 'not_owner' ? ERR_NOT_OWNER : ERR_403
  if (status === 404) return ERR_404
  if (status === 409) return ERR_CHANGED
  return fallback
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' })
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: TakeoverLoad }

export function TakeoverView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [submitting, setSubmitting] = useState<TakeoverChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<TakeoverAnswerResult | null>(null)
  const started = useRef(false)
  const inFlight = useRef(false)

  const fetchQuestion = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/takeover/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, json, ERR_LOAD) })
      setLoad({ kind: 'ready', data: json as TakeoverLoad })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchQuestion()
  }, [fetchQuestion])

  const answer = async (choice: TakeoverChoice) => {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setSubmitting(choice)
    try {
      const { status, json } = await post('/api/takeover/answer', { idToken, groupId: id, choice })
      if (status === 200) setDone(json as TakeoverAnswerResult)
      else if (status === 409) void fetchQuestion()
      else setError(errorCopy(status, json, ERR_SUBMIT))
    } catch {
      setError(ERR_SUBMIT)
    } finally {
      inFlight.current = false
      setSubmitting(null)
    }
  }

  const close = () => liff.closeWindow()
  if (done) {
    const message = done.choice === 'takeover'
      ? `กลุ่มย่อย ${done.subGroups} กลุ่มใช้แผน โควตา AI และ Google Drive ของคุณแล้ว ไฟล์เก่ายังอยู่ใน Drive ของเจ้าของเดิม`
      : `กลุ่มย่อย ${done.subGroups} กลุ่มแยกออกจากโปรเจกต์แล้ว แต่ละกลุ่มต้องตั้งค่าและเลือกเจ้าของบอทใหม่`
    return <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="บันทึกคำตอบแล้ว" message={message} onClose={close} />
  }
  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchQuestion()} onClose={close} />
    )
  }
  const { data } = load
  if (data.subGroups.length === 0) {
    return (
      <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="ไม่มีกลุ่มย่อยรอคำตอบ"
        message="ตอบไปแล้ว หรือกลุ่มย่อยแยกออกจากโปรเจกต์ไปแล้ว" onClose={close} />
    )
  }

  return (
    <Page
      title={TITLE}
      onBack={close}
      bottom={
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          <Button disabled={submitting !== null} onClick={() => void answer('takeover')}>
            {submitting === 'takeover' ? 'กำลังบันทึก...' : 'ดูแลกลุ่มย่อยต่อ'}
          </Button>
          <Button variant="secondary" disabled={submitting !== null} onClick={() => void answer('detach')}>
            {submitting === 'detach' ? 'กำลังบันทึก...' : 'แยกกลุ่มย่อยออก'}
          </Button>
        </div>
      }
    >
      <div className="pt-4">
        <h2 className="text-[20px] font-semibold leading-snug">
          คุณเป็นเจ้าของบอทของ {data.mainGroupName ?? 'โปรเจกต์นี้'} แล้ว จะดูแลกลุ่มย่อยต่อไหม
        </h2>
        <p className="mt-2 text-sm text-ink-2">
          ถ้าดูแลต่อ กลุ่มย่อยจะใช้แผน โควตา AI และ Google Drive ของคุณ ไฟล์เก่ายังอยู่ใน Drive ของเจ้าของเดิม
          ถ้าแยกออก แต่ละกลุ่มต้องตั้งค่าและเลือกเจ้าของบอทเอง
        </p>
        <ul className="mt-4 space-y-2">
          {data.subGroups.map((g) => (
            <li key={g.groupId} className="rounded-xl border border-line px-4 py-3 text-sm">{g.name ?? SUB_GROUP}</li>
          ))}
        </ul>
        {data.detachAt && (
          <p className="mt-4 text-xs text-ink-3">ถ้าไม่ตอบภายใน {formatDate(data.detachAt)} กลุ่มย่อยจะแยกออกจากโปรเจกต์เอง</p>
        )}
      </div>
    </Page>
  )
}
