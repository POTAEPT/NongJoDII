'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGoogleStatus as fetchStatus, phaseOnReturn } from './google-status'
import type { LiffViewProps } from './liff-sdk'
import { Button, IconCheck, IconCloud, IconLock, Page, StatusScreen } from './ui'

// Connect Google Drive (#3, Figma UI v4 #11). The page explains what is saved and the
// drive.file scope first; sign-in starts only on the button press.

type Phase = 'intro' | 'starting' | 'checking' | 'opened' | 'connected' | 'not_connected' | 'unauthorized' | 'failed'

const COPY: Record<'not_connected' | 'unauthorized' | 'failed', string> = {
  not_connected: 'ยังไม่ได้เชื่อม Google Drive กรุณาลองใหม่',
  unauthorized: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชตอีกครั้ง',
  failed: 'เริ่มเชื่อม Google Drive ไม่สำเร็จ กรุณาลองใหม่',
}
const TITLE = 'เชื่อม Google Drive'

/** The id the OAuth callback page links back with: sign-in already happened in
 *  the external browser, so only the status is checked. */
const RETURN_ID = 'done'

function FolderIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function GoogleView({ liff, idToken, id }: LiffViewProps) {
  const returning = id === RETURN_ID
  const [phase, setPhase] = useState<Phase>(returning ? 'checking' : 'intro')
  const started = useRef(false)
  const close = useCallback(() => liff.closeWindow(), [liff])

  const start = useCallback(async () => {
    setPhase('starting')
    try {
      // Only the ID token goes up: the server takes the user from the verified token.
      const res = await fetch('/api/google/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      })
      if (res.status === 401) return setPhase('unauthorized')
      // Any other non-200 (e.g. a bare 500 when LINE verify fails upstream) is a retryable failure.
      if (res.status !== 200) return setPhase('failed')
      const { url } = (await res.json()) as { url?: unknown }
      if (typeof url !== 'string' || !url) return setPhase('failed')
      if (liff.isInClient()) {
        // Google refuses OAuth inside LINE's in-app webview (403 disallowed_useragent),
        // so sign-in runs in the external browser; its callback page links back here.
        liff.openWindow({ url, external: true })
        setPhase('opened')
      } else {
        window.location.href = url
      }
    } catch {
      setPhase('failed')
    }
  }, [liff, idToken])

  // A return visit (id=done) only reads the status, so no new sign-in opens.
  useEffect(() => {
    if (!returning || started.current) return // StrictMode double mount must not check twice
    started.current = true
    void fetchStatus(idToken).then(setPhase)
  }, [returning, idToken])

  // While the external browser is open, re-check only when the user comes back to
  // LINE (visibility or focus). No timer polling.
  useEffect(() => {
    if (phase !== 'opened') return
    let inFlight = false
    const recheck = async () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const next = phaseOnReturn(await fetchStatus(idToken))
        if (next) setPhase(next)
      } finally {
        inFlight = false
      }
    }
    const onEvent = () => void recheck()
    document.addEventListener('visibilitychange', onEvent)
    window.addEventListener('focus', onEvent)
    return () => {
      document.removeEventListener('visibilitychange', onEvent)
      window.removeEventListener('focus', onEvent)
    }
  }, [phase, idToken])

  if (phase === 'starting') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังเตรียมเชื่อม Google Drive..." />
  if (phase === 'checking') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังตรวจสอบการเชื่อม Google Drive..." />

  if (phase === 'connected') {
    return (
      <Page title={TITLE} onBack={close} bottom={<Button onClick={close}>กลับไปที่กลุ่ม</Button>}>
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-done-bg text-done"><IconCheck className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">เชื่อม Drive แล้ว</h2>
        </div>
        <ul className="mt-6 space-y-2 rounded-2xl border border-line bg-page p-4 text-sm">
          <li className="flex items-center gap-2"><IconCheck className="h-4 w-4 text-done" /> สร้างโฟลเดอร์ NongJoDII ใน Drive ของคุณ</li>
          <li className="flex items-center gap-2"><IconCheck className="h-4 w-4 text-done" /> แยกโฟลเดอร์ให้แต่ละกลุ่ม</li>
        </ul>
        <p className="mt-4 text-center text-sm text-ink-2">ไฟล์ใหม่ในกลุ่มจะถูกเก็บที่นี่ตั้งแต่ตอนนี้</p>
      </Page>
    )
  }

  if (phase === 'opened') {
    return (
      <Page title={TITLE} onBack={close} bottom={<Button variant="outline" onClick={() => void start()}>เปิดหน้าเข้าสู่ระบบอีกครั้ง</Button>}>
        <div className="flex flex-col items-center pt-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconCloud className="h-7 w-7" /></span>
          <h2 className="mt-4 text-lg font-semibold">เข้าสู่ระบบ Google ในเบราว์เซอร์</h2>
          <p className="mt-2 text-sm text-ink-2">เมื่อเสร็จแล้วให้กลับมาที่ LINE หน้านี้จะตรวจสอบให้อัตโนมัติ</p>
        </div>
      </Page>
    )
  }

  if (phase !== 'intro') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="เชื่อม Google Drive ไม่สำเร็จ" message={COPY[phase]}
        onRetry={phase === 'unauthorized' ? undefined : () => void start()} onClose={close} />
    )
  }

  return (
    <Page title={TITLE} onBack={close} bottom={<Button onClick={() => void start()}>เข้าสู่ระบบด้วย Google</Button>}>
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft text-primary"><IconCloud className="h-7 w-7" /></span>
      <h2 className="mt-4 text-xl font-semibold">เก็บไฟล์จากกลุ่มไว้ใน Drive ของคุณ</h2>
      <p className="mt-2 text-sm text-ink-2">น้องจดดีจะสร้างโฟลเดอร์ให้แต่ละกลุ่ม ไฟล์ที่ส่งในกลุ่มจะถูกเก็บอัตโนมัติ</p>

      <div className="mt-5 rounded-2xl border border-line bg-page p-4 text-sm">
        <p className="text-xs text-ink-3">โครงสร้างโฟลเดอร์</p>
        <p className="mt-2 flex items-center gap-2 font-semibold"><FolderIcon className="h-5 w-5 text-primary" /> NongJoDII</p>
        <p className="mt-2 flex items-center gap-2 pl-6"><FolderIcon className="h-4 w-4 text-ink-2" /> กลุ่มโปรเจกต์</p>
        <p className="mt-2 flex items-center gap-2 pl-12"><FolderIcon className="h-4 w-4 text-ink-2" /> ไฟล์ของกลุ่ม</p>
        <p className="mt-2 flex items-center gap-2 pl-6"><FolderIcon className="h-4 w-4 text-ink-2" /> กลุ่มย่อย</p>
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-xl bg-primary-soft px-3 py-3 text-sm text-primary">
        <IconLock className="mt-0.5 h-4 w-4 shrink-0" />
        ขอสิทธิ์เฉพาะไฟล์ที่น้องจดดีสร้าง (drive.file) ไม่เห็นไฟล์อื่นใน Drive ของคุณ
      </p>
    </Page>
  )
}
