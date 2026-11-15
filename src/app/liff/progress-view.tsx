'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProgressLiffBody } from '@/server/progress/liff'
import type { LiffViewProps } from './liff-sdk'
import { finishSend, initialPage, startSend, type ProgressPage, type SendResult } from './progress-model'
import { Button, IconCheck, Notice, Page, Spinner, StatusScreen, inputClass } from './ui'

// #7: opened from the bot's "ยืนยันตัวตน" button when LINE sent a card press without the
// presser's user ID. `id` is that press's postback data (IDs only). The page repeats the
// press with the verified LIFF ID token and shows the answer; a picker shows its choices,
// which stay on screen until a pick goes through (progress-model.ts). Styled like the
// progress cards in chat (Figma UI v4 #5).

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชตอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงตอบการ์ดนี้ไม่ได้'
const ERR_404 = 'ไม่พบการ์ดหรืองานนี้แล้ว'
const ERR_OTHER = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'
const TITLE = 'อัปเดตความคืบหน้า'
const FINAL = new Set(['updated', 'kept', 'dismissed'])

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
  const close = useCallback(() => liff.closeWindow(), [liff])
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

  if (page.fatal) {
    return <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="บันทึกไม่สำเร็จ" message={page.fatal} onClose={close} />
  }
  if (!page.body) return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังบันทึก..." />

  const { text, choices, result, datePick } = page.body
  const final = FINAL.has(result) && choices.length === 0
  return (
    <Page title={TITLE} onBack={close} bottom={<Button variant={final ? 'primary' : 'outline'} onClick={close}>กลับไปที่แชต</Button>}>
      <section className="rounded-2xl border border-line bg-page p-4">
        {final && (
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-done-bg text-done">
            <IconCheck className="h-5 w-5" />
          </span>
        )}
        <p className="text-base whitespace-pre-wrap">{text}</p>
        {choices.length > 0 && (
          <div className="mt-4 space-y-2">
            {choices.map((c) => (
              <Button key={c.data} variant="secondary" disabled={page.sending} onClick={() => void send(c.data)}>
                {c.label}
              </Button>
            ))}
          </div>
        )}
        {datePick && (
          // #45 "เลือกวันเอง": the LIFF stand-in for LINE's date picker.
          <div className="mt-4 space-y-2">
            <input
              type="date"
              aria-label={datePick.label}
              min={datePick.min}
              value={pickedDate || datePick.initial}
              onChange={(e) => setPickedDate(e.target.value)}
              className={inputClass}
            />
            <Button disabled={page.sending} onClick={() => void send(datePick.data, pickedDate || datePick.initial)}>
              {datePick.label}
            </Button>
          </div>
        )}
      </section>
      <div className="mt-3 space-y-2">
        {page.notice && <Notice tone="info">{page.notice}</Notice>}
        {page.sending && (
          <p className="flex items-center gap-2 text-sm text-ink-2" role="status"><Spinner /> กำลังบันทึก...</p>
        )}
      </div>
    </Page>
  )
}
