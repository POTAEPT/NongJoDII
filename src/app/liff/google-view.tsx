'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiffViewProps } from './liff-sdk'

type Phase = 'starting' | 'opened' | 'unauthorized' | 'failed'

const COPY: Record<Exclude<Phase, 'starting'>, string> = {
  opened: 'เปิดเบราว์เซอร์เพื่อเข้าสู่ระบบ Google แล้ว เมื่อเสร็จให้กลับมาที่แชท LINE',
  unauthorized: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง',
  failed: 'เริ่มเชื่อม Google Drive ไม่สำเร็จ กรุณาลองใหม่',
}

export function GoogleView({ liff, idToken }: LiffViewProps) {
  const [phase, setPhase] = useState<Phase>('starting')
  const started = useRef(false)

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
        // Google refuses OAuth inside LINE's in-app webview.
        liff.openWindow({ url, external: true })
        setPhase('opened')
      } else {
        window.location.href = url
      }
    } catch {
      setPhase('failed')
    }
  }, [liff, idToken])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not start sign-in twice
    started.current = true
    void start()
  }, [start])

  if (phase === 'starting') return <p className="p-4 text-base">กำลังเตรียมเชื่อม Google Drive...</p>
  return (
    <div className="p-4 text-base">
      <p>{COPY[phase]}</p>
      <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void start()}>
        ลองอีกครั้ง
      </button>
    </div>
  )
}
