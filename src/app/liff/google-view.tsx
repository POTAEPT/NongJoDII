'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGoogleStatus as fetchStatus, phaseOnReturn } from './google-status'
import type { LiffViewProps } from './liff-sdk'

type Phase = 'starting' | 'checking' | 'opened' | 'connected' | 'not_connected' | 'unauthorized' | 'failed'

const COPY: Record<Exclude<Phase, 'starting' | 'checking' | 'connected'>, string> = {
  opened: 'เปิดเบราว์เซอร์เพื่อเข้าสู่ระบบ Google แล้ว เมื่อเสร็จให้กลับมาที่แชท LINE',
  not_connected: 'ยังไม่ได้เชื่อม Google Drive กรุณาลองใหม่',
  unauthorized: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง',
  failed: 'เริ่มเชื่อม Google Drive ไม่สำเร็จ กรุณาลองใหม่',
}

/** The id the OAuth callback page links back with: sign-in already happened in
 *  the external browser, so only the status is checked. */
const RETURN_ID = 'done'

export function GoogleView({ liff, idToken, id }: LiffViewProps) {
  const returning = id === RETURN_ID
  const [phase, setPhase] = useState<Phase>(returning ? 'checking' : 'starting')
  const started = useRef(false)

  // Callers set 'starting' first (initial state on mount, retry() on a click).
  const start = useCallback(async () => {
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

  // First load: a return visit (id=done) starts in 'checking' and only reads the
  // status, so no new sign-in opens; any other visit starts sign-in.
  const init = useCallback(async () => {
    if (!returning) return start()
    const status = await fetchStatus(idToken)
    setPhase(status)
  }, [returning, idToken, start])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not start sign-in twice
    started.current = true
    void init()
  }, [init])

  const retry = () => {
    setPhase('starting')
    void start()
  }

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

  if (phase === 'starting') return <p className="p-4 text-base">กำลังเตรียมเชื่อม Google Drive...</p>
  if (phase === 'checking') return <p className="p-4 text-base">กำลังตรวจสอบการเชื่อม Google Drive...</p>
  if (phase === 'connected') {
    return (
      <div className="p-4 text-base">
        <p className="text-lg font-bold">เชื่อม Google Drive สำเร็จ</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
          ปิดหน้านี้
        </button>
      </div>
    )
  }
  return (
    <div className="p-4 text-base">
      <p>{COPY[phase]}</p>
      <button type="button" className="mt-4 rounded border px-4 py-2" onClick={retry}>
        ลองอีกครั้ง
      </button>
    </div>
  )
}
