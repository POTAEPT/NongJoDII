'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { liffUrl } from '@/server/liff-links'
import type { NotifyResult, ReviewView as ReviewData, SubmitResult } from '@/server/review/types'
import { errorCopy, post } from './api'
import { bangkokToday, dueLabel } from './display'
import {
  countDecisions, initialForms, needsDeclineConfirm, summarizeResults, toDecisions, validateForms,
  type CandidateForm, type SavedTask,
} from './form-model'
import type { LiffViewProps } from './liff-sdk'
import {
  AssigneeChip, AssigneeSheet, Button, Chip, DueChip, Field, IconCheck, Notice, Page, StatusScreen, inputClass,
} from './ui'

// #5 review (Figma UI v4 #3c / #3d): pick which proposed Tasks to create, edit each
// one, then create them. Declines are final, so a decline-only submit asks first.

const COPY = {
  forbidden: 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงยืนยันงานไม่ได้',
  notFound: 'ไม่พบสรุปนี้',
}
const ERR_LOAD = 'เชื่อมต่อไม่ได้ชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่'
const ERR_SUBMIT = 'ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const TITLE = 'ตรวจงานที่ได้จากแชต'

type Announce = 'idle' | 'working' | 'posted' | 'quota' | 'failed'

const ANNOUNCE_COPY: Record<Exclude<Announce, 'idle'>, string> = {
  working: 'กำลังแจ้งในกลุ่ม...',
  posted: 'แจ้งในกลุ่มแล้ว',
  quota: 'งานถูกสร้างแล้ว แต่เดือนนี้แจ้งในกลุ่มไม่ได้ (โควตาข้อความใกล้หมด)',
  failed: 'งานถูกสร้างแล้ว แต่แจ้งในกลุ่มไม่สำเร็จ',
}

/** Asks the bot to tell the group which Tasks were created (a push: it counts
 *  against the LINE quota and is skipped near the limit). The server claims the Tasks
 *  as a batch and pushes it with the batch's token as the LINE retry key; a retry
 *  resends a failed batch with the same key, so repeating this call never repeats the
 *  message. */
async function announce(
  idToken: string, summaryId: string, taskIds: string[],
): Promise<Exclude<Announce, 'idle' | 'working'>> {
  if (taskIds.length === 0) return 'failed'
  try {
    const { status, json } = await post('/api/review/notify', { idToken, summaryId, taskIds })
    if (status !== 200) return 'failed'
    const n = json as NotifyResult
    return n.posted || n.reason !== 'quota' ? 'posted' : 'quota'
  } catch {
    return 'failed'
  }
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ready'; data: ReviewData }

export function ReviewView({ liff, idToken, liffId, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [forms, setForms] = useState<CandidateForm[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState<SubmitResult | null>(null)
  const [announced, setAnnounced] = useState<Announce>('idle')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [picking, setPicking] = useState<string | null>(null) // candidateId whose assignee sheet is open
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double submit before state re-renders
  const close = useCallback(() => liff.closeWindow(), [liff])

  const fetchReview = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', status: 404, message: COPY.notFound })
    try {
      const { status, json } = await post('/api/review/load', { idToken, summaryId: id })
      if (status !== 200) return setLoad({ kind: 'error', status, message: errorCopy(status, { ...COPY, fallback: ERR_LOAD }) })
      const data = json as ReviewData
      setForms(initialForms(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', status: 0, message: ERR_LOAD })
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
        if (status !== 200) setFormError(errorCopy(status, { ...COPY, fallback: ERR_SUBMIT }))
        else {
          const result = json as SubmitResult
          setDone(result)
          const feedback = result.feedback
          if (result.feedbackFailed) setAnnounced('failed')
          else if (feedback && id) {
            setAnnounced('working')
            void announce(idToken, id, feedback.taskIds).then(setAnnounced)
          }
        }
      } catch {
        setFormError(ERR_SUBMIT)
      } finally {
        inFlight.current = false
        setSubmitting(false)
      }
    },
    [idToken, id],
  )

  const update = (candidateId: string, patch: Partial<CandidateForm>) =>
    setForms((prev) => prev.map((f) => (f.candidateId === candidateId ? { ...f, ...patch } : f)))

  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    if (load.status === 403) {
      return <StatusScreen kind="forbidden" appTitle={TITLE} onBack={close} title="ไม่ใช่สมาชิกกลุ่มนี้" message={load.message} onClose={close} />
    }
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchReview()} onClose={close} />
    )
  }

  const { data } = load
  const memberOf = (lineUserId: string) => data.members.find((m) => m.lineUserId === lineUserId)

  if (done) {
    const { created, existing, declined } = summarizeResults(done.results)
    const titleOf = (candidateId: string) => forms.find((f) => f.candidateId === candidateId)?.title.trim() ?? ''
    const taskList = (tasks: SavedTask[]) => (
      <ul className="mt-2 space-y-2">
        {tasks.map((r) => (
          <li key={r.candidateId} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-page p-3">
            <span className="min-w-0 break-words font-semibold">{titleOf(r.candidateId)}</span>
            <a className="shrink-0 text-sm font-semibold text-primary" href={liffUrl(liffId, 'task', r.taskId)}>แก้</a>
          </li>
        ))}
      </ul>
    )
    return (
      <Page title={TITLE} onBack={close} bottom={<Button onClick={close}>กลับไปที่กลุ่ม</Button>}>
        <div className="flex flex-col items-center pt-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-done-bg text-done"><IconCheck className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">สร้างงานแล้ว {created.length} งาน</h2>
          {declined > 0 && <p className="mt-1 text-sm text-ink-2">ไม่สร้าง {declined} งาน</p>}
        </div>
        {created.length > 0 && taskList(created)}
        {existing.length > 0 && (
          <section className="mt-6">
            <h3 className="font-semibold">งานที่บันทึกไว้แล้ว {existing.length} งาน</h3>
            <p className="text-sm text-ink-2">งานเหล่านี้ถูกสร้างไว้ก่อนแล้ว ไม่ได้สร้างซ้ำ</p>
            {taskList(existing)}
          </section>
        )}
        {announced !== 'idle' && (
          <div className="mt-6 space-y-2">
            <Notice tone={announced === 'posted' ? 'success' : announced === 'working' ? 'info' : 'error'}>
              {ANNOUNCE_COPY[announced]}
            </Notice>
            {announced === 'failed' && id && (
              <Button
                variant="secondary"
                onClick={() => {
                  // Only the notification is retried; the Tasks are already saved. The
                  // server builds the message, so this also works when submit could not.
                  const taskIds = done.feedback?.taskIds ??
                    done.results.flatMap((r) => (r.taskId ? [r.taskId] : []))
                  setAnnounced('working')
                  void announce(idToken, id, taskIds).then(setAnnounced)
                }}
              >
                ลองแจ้งในกลุ่มอีกครั้ง
              </Button>
            )}
          </div>
        )}
      </Page>
    )
  }

  const counts = countDecisions(forms)
  const disabled = submitting
  const today = bangkokToday() // only after load, which runs in the browser (never during prerender)
  const chosen = forms.filter((f) => f.editable && f.selected)
  const allReady = chosen.length > 0 && chosen.every((f) => f.assigneeLineUserId && f.dueDate)
  const pickingForm = forms.find((f) => f.candidateId === picking)

  return (
    <Page
      title={TITLE}
      onBack={close}
      bottom={
        <div className="space-y-2">
          {formError && <Notice>{formError}</Notice>}
          <Button disabled={disabled} onClick={() => void submit(forms)}>
            {submitting ? 'กำลังสร้าง...' : `สร้าง ${counts.confirm} งาน`}
          </Button>
          <p className="text-center text-xs text-ink-3">สร้างแล้วจะส่งการ์ดงานเข้ากลุ่มให้ทุกคนเห็น</p>
        </div>
      }
    >
      <p className="text-sm text-ink-2">เลือกงานที่จะสร้าง แก้ไขแต่ละงานได้ก่อนกดยืนยัน</p>

      <details className="mt-3 rounded-xl bg-page px-3 py-2 text-sm">
        <summary className="cursor-pointer font-semibold text-primary">ดูสรุปแชต</summary>
        <p className="mt-2 whitespace-pre-wrap text-ink-2">{data.summaryText}</p>
      </details>

      {allReady && (
        <p className="mt-3 flex items-center gap-2 rounded-xl bg-done-bg px-3 py-2 text-sm text-done">
          <IconCheck className="h-4 w-4 shrink-0" /> ทุกงานมีผู้รับและกำหนดส่งแล้ว พร้อมสร้าง
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {forms.map((f, i) => {
          const state = data.candidates[i].state
          if (!f.editable) {
            return (
              <li key={f.candidateId} className="rounded-2xl border border-line bg-page p-4 opacity-70">
                <Chip tone={state === 'confirmed' ? 'done' : 'neutral'}>{state === 'confirmed' ? 'ยืนยันแล้ว' : 'ไม่สร้าง'}</Chip>
                <p className="mt-2 break-words font-semibold">{f.title}</p>
              </li>
            )
          }
          const open = expanded === f.candidateId
          return (
            <li key={f.candidateId}
              className={`rounded-2xl border border-line bg-page p-4 transition-opacity ${f.selected ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  aria-label="สร้างงานนี้"
                  className="mt-1 h-5 w-5 shrink-0 accent-primary"
                  checked={f.selected}
                  disabled={disabled}
                  onChange={(e) => update(f.candidateId, { selected: e.target.checked })}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-base font-semibold">{f.title || 'ไม่มีชื่องาน'}</p>
                  {f.details && !open && <p className="mt-0.5 line-clamp-2 text-sm text-ink-2">{f.details}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <AssigneeChip member={memberOf(f.assigneeLineUserId)} disabled={disabled}
                      onClick={() => setPicking(f.candidateId)} />
                    <DueChip label={dueLabel(f.dueDate, f.dueTime, today)} />
                    <button type="button" className="ml-auto px-1 text-sm font-semibold text-primary"
                      aria-expanded={open} onClick={() => setExpanded(open ? null : f.candidateId)}>
                      {open ? 'เสร็จ' : 'แก้'}
                    </button>
                  </div>
                </div>
              </div>
              {open && (
                <div className="mt-4 space-y-4 border-t border-line pt-4">
                  <Field label="ชื่องาน">
                    <input type="text" maxLength={200} className={inputClass} value={f.title} disabled={disabled}
                      onChange={(e) => update(f.candidateId, { title: e.target.value })} />
                  </Field>
                  <Field label="รายละเอียด">
                    <textarea maxLength={2000} rows={3} className={inputClass} value={f.details} disabled={disabled}
                      onChange={(e) => update(f.candidateId, { details: e.target.value })} />
                  </Field>
                  <div className="flex gap-2">
                    <div className="flex-1"><Field label="กำหนดส่ง">
                      <input type="date" className={inputClass} value={f.dueDate} disabled={disabled}
                        onChange={(e) => update(f.candidateId, { dueDate: e.target.value })} />
                    </Field></div>
                    <div className="flex-1"><Field label="เวลา">
                      <input type="time" className={inputClass} value={f.dueTime} disabled={disabled}
                        onChange={(e) => update(f.candidateId, { dueTime: e.target.value })} />
                    </Field></div>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-6 space-y-2">
        {counts.decline > 0 && (
          <p className="text-center text-sm text-ink-2">ไม่สร้าง {counts.decline} งานที่ไม่ได้เลือก และเลือกกลับมาไม่ได้</p>
        )}
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            const none = forms.map((f) => ({ ...f, selected: false }))
            void submit(none, () => setForms(none))
          }}
        >
          ไม่สร้างงานทั้งหมด
        </Button>
      </div>

      <AssigneeSheet
        open={pickingForm !== undefined}
        subtitle={pickingForm?.title}
        members={data.members}
        value={pickingForm?.assigneeLineUserId ?? ''}
        onClose={() => setPicking(null)}
        onConfirm={(lineUserId) => {
          if (pickingForm) update(pickingForm.candidateId, { assigneeLineUserId: lineUserId })
          setPicking(null)
        }}
      />
    </Page>
  )
}
