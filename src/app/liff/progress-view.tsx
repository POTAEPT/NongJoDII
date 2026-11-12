'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressLiffBody } from '@/server/progress/liff'
import type { LiffViewProps } from './liff-sdk'

// #7: opened from the bot's "ยืนยันตัวตน" button when LINE sent a card press without the
// presser's user ID. `id` is that press's postback data (IDs only). The page repeats the
// press with the verified LIFF ID token and shows the answer; a picker shows its choices.

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงตอบการ์ดนี้ไม่ได้'
const ERR_404 = 'ไม่พบการ์ดหรืองานนี้แล้ว'
const ERR_OTHER = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404 || status === 400) return ERR_404
  return ERR_OTHER
}

type State = { kind: 'sending' } | { kind: 'error'; message: string } | { kind: 'done'; body: ProgressLiffBody }

export function ProgressView({ idToken, id, liff }: LiffViewProps) {
  const [state, setState] = useState<State>({ kind: 'sending' })
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double press before state re-renders

  const send = useCallback(async (data: string | null) => {
    if (inFlight.current) return
    if (!data) return setState({ kind: 'error', message: ERR_404 })
    inFlight.current = true
    setState({ kind: 'sending' })
    try {
      const res = await fetch('/api/progress/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken, data }),
      })
      if (res.status !== 200) return setState({ kind: 'error', message: errorCopy(res.status) })
      setState({ kind: 'done', body: (await res.json()) as ProgressLiffBody })
    } catch {
      setState({ kind: 'error', message: ERR_OTHER })
    } finally {
      inFlight.current = false
    }
  }, [idToken])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not send twice
    started.current = true
    void send(id)
  }, [send, id])

  if (state.kind === 'sending') return <p className="p-4 text-base">กำลังบันทึก...</p>
  if (state.kind === 'error') return <p className="p-4 text-base">{state.message}</p>

  const { text, choices } = state.body
  return (
    <main className="flex flex-col gap-3 p-4">
      <p className="text-base">{text}</p>
      {choices.map((c) => (
        <button
          key={c.data}
          type="button"
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-base text-blue-900"
          onClick={() => void send(c.data)}
        >
          {c.label}
        </button>
      ))}
      <button type="button" className="px-4 py-3 text-base text-blue-700" onClick={() => liff.closeWindow()}>
        กลับไปที่แชท
      </button>
    </main>
  )
}
