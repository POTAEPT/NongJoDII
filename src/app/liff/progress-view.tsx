'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressLiffBody } from '@/server/progress/liff'
import type { LiffViewProps } from './liff-sdk'
import { finishSend, initialPage, startSend, type ProgressPage, type SendResult } from './progress-model'

// #7: opened from the bot's "ยืนยันตัวตน" button when LINE sent a card press without the
// presser's user ID. `id` is that press's postback data (IDs only). The page repeats the
// press with the verified LIFF ID token and shows the answer; a picker shows its choices,
// which stay on screen until a pick goes through (progress-model.ts).

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

export function ProgressView({ idToken, id, liff }: LiffViewProps) {
  const [page, setPage] = useState<ProgressPage>(initialPage)
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double press before state re-renders

  const [pickedDate, setPickedDate] = useState('')

  const send = useCallback(async (data: string | null, date?: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setPage(startSend)
    let res: SendResult
    if (!data) {
      res = { ok: false, message: ERR_404 }
    } else {
      try {
        const r = await fetch('/api/progress/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idToken, data, ...(date ? { pickedDate: date } : {}) }),
        })
        res = r.status === 200
          ? { ok: true, body: (await r.json()) as ProgressLiffBody }
          : { ok: false, message: errorCopy(r.status) }
      } catch {
        res = { ok: false, message: ERR_OTHER }
      }
    }
    inFlight.current = false
    setPage((p) => finishSend(p, res))
  }, [idToken])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not send twice
    started.current = true
    void send(id)
  }, [send, id])

  if (page.fatal) return <p className="p-4 text-base">{page.fatal}</p>
  if (!page.body) return <p className="p-4 text-base">กำลังบันทึก...</p>

  const { text, choices, datePick } = page.body
  return (
    <main className="flex flex-col gap-3 p-4">
      <p className="text-base">{text}</p>
      {page.notice && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{page.notice}</p>}
      {page.sending && <p className="text-sm text-gray-500">กำลังบันทึก...</p>}
      {choices.map((c) => (
        <button
          key={c.data}
          type="button"
          disabled={page.sending}
          className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-base text-blue-900 disabled:opacity-50"
          onClick={() => void send(c.data)}
        >
          {c.label}
        </button>
      ))}
      {datePick && (
        // #45 "เลือกวันเอง": the LIFF stand-in for LINE's date picker.
        <div className="flex gap-2">
          <input
            type="date"
            aria-label={datePick.label}
            min={datePick.min}
            value={pickedDate || datePick.initial}
            onChange={(e) => setPickedDate(e.target.value)}
            className="flex-1 rounded-lg border border-blue-200 px-3 py-2 text-base"
          />
          <button
            type="button"
            disabled={page.sending}
            className="rounded-lg bg-blue-700 px-4 py-2 text-base text-white disabled:opacity-50"
            onClick={() => void send(datePick.data, pickedDate || datePick.initial)}
          >
            {datePick.label}
          </button>
        </div>
      )}
      <button type="button" className="px-4 py-3 text-base text-blue-700" onClick={() => liff.closeWindow()}>
        กลับไปที่แชท
      </button>
    </main>
  )
}
