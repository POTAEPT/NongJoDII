'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { liffUrl } from '@/server/liff-links'
import type { NotifyResult, ReviewView as ReviewData, SubmitResult } from '@/server/review/types'
import {
  countDecisions, initialForms, needsDeclineConfirm, summarizeResults, toDecisions, validateForms,
  type CandidateForm, type SavedTask,
} from './form-model'
import type { LiffViewProps } from './liff-sdk'

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงยืนยันงานไม่ได้'
const ERR_404 = 'ไม่พบสรุปนี้'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_SUBMIT = 'ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404) return ERR_404
  if (status === 400) return ERR_400
  return fallback
}

// Only the LIFF ID token goes up as identity: the server verifies it with LINE.
async function post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  if (res.status === 200) json = await res.json()
  return { status: res.status, json }
}

type Announce = 'idle' | 'working' | 'posted' | 'quota' | 'failed'

const ANNOUNCE_COPY: Record<Exclude<Announce, 'idle'>, string> = {
  working: 'กำลังแจ้งในกลุ่ม...',
  posted: 'แจ้งในกลุ่มแล้ว',
  quota: 'งานถูกสร้างแล้ว แต่เดือนนี้แจ้งในกลุ่มไม่ได้ (โควตาข้อความใกล้หมด)',
  failed: 'งานถูกสร้างแล้ว แต่แจ้งในกลุ่มไม่สำเร็จ',
}

/** Tells the group which Tasks were created: first as the member's own message from
 *  this LIFF page (free), else by asking the server to push it (counts against the
 *  LINE quota). sendMessages posts to whichever chat opened the page, and LIFF no
 *  longer exposes a group ID to check it against the Summary's group, so the member
 *  confirms the chat first; the bot's push always goes to the right group. */
async function announce(
  liff: LiffViewProps['liff'], idToken: string, summaryId: string,
  feedback: { text: string | null; taskIds: string[] }, allowSelf: boolean,
): Promise<Exclude<Announce, 'idle' | 'working'>> {
  const { text, taskIds } = feedback
  if (taskIds.length === 0) return 'failed'
  if (
    allowSelf && text !== null && liff.isInClient() && liff.getContext()?.type === 'group' && liff.isApiAvailable('sendMessages') &&
    window.confirm('แจ้งงานที่สร้างในแชทกลุ่มนี้? (ต้องเป็นกลุ่มเดียวกับที่สรุปแชท) กด "ยกเลิก" ให้น้องจดดีแจ้งแทน')
  ) {
    try {
      await liff.sendMessages([{ type: 'text', text }])
      // Mark them announced, so a later submit does not offer them again.
      await post('/api/review/notify', { idToken, summaryId, taskIds, mode: 'self' }).catch(() => undefined)
      return 'posted'
    } catch {
      // Not granted: fall back to the bot's push.
    }
  }
  try {
    const { status, json } = await post('/api/review/notify', { idToken, summaryId, taskIds, mode: 'push' })
    if (status !== 200) return 'failed'
    const n = json as NotifyResult
    return n.posted || n.reason !== 'quota' ? 'posted' : 'quota'
  } catch {
    return 'failed'
  }
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: ReviewData }

export function ReviewView({ liff, idToken, liffId, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [forms, setForms] = useState<CandidateForm[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState<SubmitResult | null>(null)
  const [announced, setAnnounced] = useState<Announce>('idle')
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double submit before state re-renders

  const fetchReview = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/review/load', { idToken, summaryId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, ERR_LOAD) })
      const data = json as ReviewData
      setForms(initialForms(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchReview()
  }, [fetchReview])

  const submit = useCallback(
    async (next: CandidateForm[], onProceed?: () => void) => {
      if (inFlight.current) return
      const invalid = validateForms(next)
      if (invalid) return setFormError(invalid)
      const counts = countDecisions(next)
      if (needsDeclineConfirm(counts) && !window.confirm(`ยืนยันไม่สร้างงานทั้งหมด ${counts.decline} งาน? ยกเลิกภายหลังไม่ได้`)) return
      inFlight.current = true
      onProceed?.()
      setFormError(null)
      setSubmitting(true)
      try {
        const { status, json } = await post('/api/review/submit', {
          idToken,
          summaryId: id,
          decisions: toDecisions(next),
        })
        if (status !== 200) setFormError(errorCopy(status, ERR_SUBMIT))
        else {
          const result = json as SubmitResult
          setDone(result)
          const feedback = result.feedback
          if (result.feedbackFailed) setAnnounced('failed')
          else if (feedback && id) {
            setAnnounced('working')
            void announce(liff, idToken, id, feedback, true).then(setAnnounced)
          }
        }
      } catch {
        setFormError(ERR_SUBMIT)
      } finally {
        inFlight.current = false
        setSubmitting(false)
      }
    },
    [liff, idToken, id],
  )

  const update = (candidateId: string, patch: Partial<CandidateForm>) =>
    setForms((prev) => prev.map((f) => (f.candidateId === candidateId ? { ...f, ...patch } : f)))

  if (load.kind === 'loading') return <p className="p-4 text-base">กำลังโหลด...</p>
  if (load.kind === 'error') {
    return (
      <div className="p-4 text-base">
        <p>{load.message}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchReview()}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }

  const { data } = load
  if (done) {
    const { created, existing, declined } = summarizeResults(done.results)
    const titleOf = (candidateId: string) => forms.find((f) => f.candidateId === candidateId)?.title.trim() ?? ''
    const taskList = (tasks: SavedTask[]) => (
      <ul className="mt-2 space-y-2">
        {tasks.map((r) => (
          <li key={r.candidateId} className="flex items-center justify-between gap-2 rounded border p-2">
            <span className="min-w-0 break-words">{titleOf(r.candidateId)}</span>
            <a className="shrink-0 underline" href={liffUrl(liffId, 'task', r.taskId)}>
              แก้ไข
            </a>
          </li>
        ))}
      </ul>
    )
    return (
      <div className="p-4 text-base">
        <h1 className="text-lg font-bold">สร้างงานแล้ว {created.length} งาน</h1>
        {taskList(created)}
        {existing.length > 0 && (
          <>
            <h2 className="mt-4 font-bold">งานที่บันทึกไว้แล้ว {existing.length} งาน</h2>
            <p className="text-sm opacity-80">งานเหล่านี้ถูกสร้างไว้ก่อนแล้ว ไม่ได้สร้างซ้ำ</p>
            {taskList(existing)}
          </>
        )}
        <p className="mt-3">ไม่สร้าง {declined} งาน</p>
        {announced !== 'idle' && <p className="mt-2 text-sm opacity-80">{ANNOUNCE_COPY[announced]}</p>}
        {announced === 'failed' && id && (
          <button
            type="button"
            className="mt-2 rounded border px-4 py-2"
            onClick={() => {
              // Only the notification is retried; the Tasks are already saved. The
              // server rebuilds the message, so this also works when submit could not.
              const taskIds = done.feedback?.taskIds ??
                done.results.flatMap((r) => (r.taskId ? [r.taskId] : []))
              setAnnounced('working')
              void announce(liff, idToken, id, { text: null, taskIds }, false).then(setAnnounced)
            }}
          >
            ลองแจ้งในกลุ่มอีกครั้ง
          </button>
        )}
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
          ปิด
        </button>
      </div>
    )
  }

  const counts = countDecisions(forms)
  const disabled = submitting

  return (
    <div className="p-4 text-base">
      <h1 className="text-lg font-bold">ตรวจและยืนยันงาน</h1>
      <p className="mt-2 whitespace-pre-wrap rounded bg-black/5 p-3 text-sm opacity-80">{data.summaryText}</p>

      <div className="mt-4 space-y-4">
        {forms.map((f, i) => {
          const state = data.candidates[i].state
          return (
            <section key={f.candidateId} className="space-y-2 rounded border p-3">
              {f.editable ? (
                <>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={f.selected}
                      disabled={disabled}
                      onChange={(e) => update(f.candidateId, { selected: e.target.checked })}
                    />
                    สร้างงานนี้
                  </label>
                  <label className="block">
                    <span className="text-sm">ชื่องาน</span>
                    <input
                      type="text"
                      maxLength={200}
                      className="mt-1 w-full rounded border p-2"
                      value={f.title}
                      disabled={disabled}
                      onChange={(e) => update(f.candidateId, { title: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm">รายละเอียด</span>
                    <textarea
                      maxLength={2000}
                      rows={3}
                      className="mt-1 w-full rounded border p-2"
                      value={f.details}
                      disabled={disabled}
                      onChange={(e) => update(f.candidateId, { details: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    <span className="text-sm">ผู้รับผิดชอบ</span>
                    <select
                      className="mt-1 w-full rounded border p-2"
                      value={f.assigneeLineUserId}
                      disabled={disabled}
                      onChange={(e) => update(f.candidateId, { assigneeLineUserId: e.target.value })}
                    >
                      <option value="">ยังไม่มีผู้รับ</option>
                      {data.members.map((m) => (
                        <option key={m.lineUserId} value={m.lineUserId}>
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex gap-2">
                    <label className="block flex-1">
                      <span className="text-sm">กำหนดส่ง</span>
                      <input
                        type="date"
                        className="mt-1 w-full rounded border p-2"
                        value={f.dueDate}
                        disabled={disabled}
                        onChange={(e) => update(f.candidateId, { dueDate: e.target.value })}
                      />
                    </label>
                    <label className="block flex-1">
                      <span className="text-sm">เวลา</span>
                      <input
                        type="time"
                        className="mt-1 w-full rounded border p-2"
                        value={f.dueTime}
                        disabled={disabled}
                        onChange={(e) => update(f.candidateId, { dueTime: e.target.value })}
                      />
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <span className="inline-block rounded bg-black/10 px-2 py-0.5 text-sm">
                    {state === 'confirmed' ? 'ยืนยันแล้ว' : 'ไม่สร้าง'}
                  </span>
                  <p className="break-words">{f.title}</p>
                </>
              )}
            </section>
          )
        })}
      </div>

      <div className="mt-4 space-y-2">
        {formError && <p role="alert">{formError}</p>}
        {counts.decline > 0 && <p className="text-sm">ไม่สร้าง {counts.decline} งานที่ไม่ได้เลือก และเลือกกลับมาไม่ได้</p>}
        <button
          type="button"
          className="w-full rounded border px-4 py-2 font-bold"
          disabled={disabled}
          onClick={() => void submit(forms)}
        >
          สร้างงานที่เลือก ({counts.confirm})
        </button>
        <button
          type="button"
          className="w-full rounded border px-4 py-2"
          disabled={disabled}
          onClick={() => {
            const none = forms.map((f) => ({ ...f, selected: false }))
            void submit(none, () => setForms(none))
          }}
        >
          ไม่สร้างงานทั้งหมด
        </button>
      </div>
    </div>
  )
}
