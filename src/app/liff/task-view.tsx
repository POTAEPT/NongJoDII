'use client'

import { TagsEditor } from './tags-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskView as TaskData } from '@/server/tasks/load'
import { ERR_400, errorCopy, post } from './api'
import { track } from './analytics'
import { splitBangkokIso, toBangkokIso } from './form-model'
import type { LiffViewProps } from './liff-sdk'
import {
  AssigneeSheet, Avatar, Button, Field, IconCalendar, IconClock, IconPlus, Notice, Page, StatusScreen, inputClass,
} from './ui'

// Edit one Task (Figma UI v4 #12 / #12b). One assignee: the API takes a single
// assigneeLineUserId.

const COPY = {
  forbidden: 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงแก้ไขงานไม่ได้',
  notFound: 'ไม่พบงานนี้',
  fallback: 'บันทึกไม่สำเร็จ กรุณาลองใหม่',
}
const ERR_LOAD = 'เชื่อมต่อไม่ได้ชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่'
/** #121: shown under the assignee when the requester may not move it (server: 403 not_allowed). */
const ASSIGNEE_LOCKED = 'เปลี่ยนผู้รับได้เฉพาะผู้รับงาน เจ้าของบอท หรือ PM'
const TITLE = 'แก้งาน'
/** #139: a Done Task can go back to open, by the same people who may move the assignee. */
const REOPEN = {
  done: 'งานนี้เสร็จแล้ว',
  hint: 'ปิดงานผิด? กดปุ่มนี้ งานจะกลับไปเป็น “กำลังทำ” (หรือ “ยังไม่มีผู้รับ” ถ้ายังไม่มีผู้รับ)',
  button: 'ยังไม่เสร็จ',
  busy: 'กำลังเปิดงาน...',
  doneMsg: 'เปิดงานแล้ว',
  changed: 'งานนี้เปลี่ยนไปแล้ว ลองดูอีกครั้ง',
  locked: 'เปิดงานใหม่ได้เฉพาะผู้รับงาน เจ้าของบอท หรือ PM',
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'ready'; data: TaskData }
type Form = { title: string; details: string; assignee: string; dueDate: string; dueTime: string; tags: string[] }

function toForm(t: TaskData): Form {
  const { date, time } = splitBangkokIso(t.dueAt)
  return { title: t.title, details: t.details ?? '', assignee: t.assigneeLineUserId ?? '', dueDate: date, dueTime: time, tags: [...(t.tags ?? [])] }
}

export function TaskView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<Form | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double submit before state re-renders

  // Back goes to the review page when the Task was opened from it, else back to chat.
  const back = useCallback(() => {
    if (window.history.length > 1) window.history.back()
    else liff.closeWindow()
  }, [liff])
  const close = useCallback(() => liff.closeWindow(), [liff])

  const fetchTask = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', status: 404, message: COPY.notFound })
    try {
      const { status, json } = await post('/api/tasks/load', { idToken, taskId: id })
      if (status !== 200) return setLoad({ kind: 'error', status, message: errorCopy(status, { ...COPY, fallback: ERR_LOAD }) })
      const data = json as TaskData
      setForm(toForm(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', status: 0, message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchTask()
  }, [fetchTask])

  const save = async () => {
    if (!form || inFlight.current) return
    if (form.title.trim() === '') return setFormError(ERR_400)
    inFlight.current = true
    setFormError(null)
    setSaved(null)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/tasks/update', {
        idToken,
        taskId: id,
        title: form.title.trim(),
        details: form.details === '' ? null : form.details,
        assigneeLineUserId: form.assignee === '' ? null : form.assignee,
        dueAt: toBangkokIso(form.dueDate, form.dueTime),
        tags: form.tags,
      })
      if (status === 403 && (json as { error?: unknown } | null)?.error === 'not_allowed') setFormError(ASSIGNEE_LOCKED)
      else if (status !== 200) setFormError(errorCopy(status, COPY))
      else {
        setLoad({ kind: 'ready', data: json as TaskData })
        setForm(toForm(json as TaskData))
        setSaved('บันทึกแล้ว')
        track('task_saved') // #19
      }
    } catch {
      setFormError(COPY.fallback)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  /** #139: "ยังไม่เสร็จ". The answer is the Task as it is now, so the form follows it. */
  const reopen = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setFormError(null)
    setSaved(null)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/tasks/reopen', { idToken, taskId: id })
      const body = json as ({ error?: unknown; task?: TaskData } & Partial<TaskData>) | null
      if (status === 200) {
        setLoad({ kind: 'ready', data: body as TaskData })
        setSaved(REOPEN.doneMsg)
        track('task_reopened')
      } else if (status === 409 && body?.task) {
        setLoad({ kind: 'ready', data: body.task })
        setFormError(REOPEN.changed)
      } else if (status === 403 && body?.error === 'not_allowed') setFormError(REOPEN.locked)
      else setFormError(errorCopy(status, COPY))
    } catch {
      setFormError(COPY.fallback)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    if (load.status === 403) {
      return <StatusScreen kind="forbidden" appTitle={TITLE} onBack={close} title="ไม่ใช่สมาชิกกลุ่มนี้" message={load.message} onClose={close} />
    }
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchTask()} onClose={close} />
    )
  }
  if (!form) return null

  const set = (patch: Partial<Form>) => {
    setSaved(null)
    setForm({ ...form, ...patch })
  }
  const assignee = load.data.members.find((m) => m.lineUserId === form.assignee)
  // #121: older payloads have no flag; the server still checks.
  const assigneeLocked = load.data.canChangeAssignee === false

  return (
    <Page
      title={TITLE}
      onBack={back}
      bottom={
        <div className="space-y-2">
          {formError && <Notice>{formError}</Notice>}
          {saved && <Notice tone="success">{saved}</Notice>}
          <div className="flex gap-3">
            <Button variant="secondary" disabled={submitting} onClick={back}>ยกเลิก</Button>
            <Button disabled={submitting} onClick={() => void save()}>{submitting ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        {load.data.status === 'done' && (
          <div className="space-y-2 rounded-xl bg-done-bg p-3">
            <p className="text-sm font-semibold text-done">{REOPEN.done}</p>
            {load.data.canReopen ? (
              <>
                <p className="text-xs text-ink-2">{REOPEN.hint}</p>
                <Button variant="secondary" disabled={submitting} onClick={() => void reopen()}>
                  {submitting ? REOPEN.busy : REOPEN.button}
                </Button>
              </>
            ) : (
              <p className="text-xs text-ink-2">{REOPEN.locked}</p>
            )}
          </div>
        )}
        <Field label="ชื่องาน">
          <input type="text" maxLength={200} className={inputClass} value={form.title} disabled={submitting}
            onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label="รายละเอียด">
          <textarea maxLength={2000} rows={2} className={inputClass} value={form.details} disabled={submitting}
            placeholder="ยังไม่มีรายละเอียด" onChange={(e) => set({ details: e.target.value })} />
        </Field>
        <Field label="แท็ก">
          <TagsEditor tags={form.tags} disabled={submitting} suggestions={load.data.tagSet}
            onChange={(tags) => set({ tags })} />
        </Field>
        <div>
          <span className="mb-2 block text-sm font-semibold">ผู้รับ</span>
          <div className="flex items-center gap-2">
            {assignee ? (
              <button type="button" disabled={submitting || assigneeLocked} onClick={() => setPicking(true)}
                className="inline-flex items-center gap-2 rounded-full border border-line bg-page py-1 pr-3 pl-1 text-sm font-semibold">
                <Avatar name={assignee.displayName} id={assignee.lineUserId} size="md" />
                {assignee.displayName}
              </button>
            ) : (
              <span className="text-sm text-ink-3">ยังไม่มีผู้รับ</span>
            )}
            {!assigneeLocked && (
              <button type="button" aria-label={assignee ? 'เปลี่ยนผู้รับ' : 'เลือกผู้รับ'} disabled={submitting}
                onClick={() => setPicking(true)}
                className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-soft text-primary">
                <IconPlus className="h-5 w-5" />
              </button>
            )}
          </div>
          {assigneeLocked && <p className="mt-1 text-xs text-ink-3">{ASSIGNEE_LOCKED}</p>}
        </div>
        <div>
          <span className="mb-2 block text-sm font-semibold">กำหนดส่ง</span>
          <div className="flex gap-2">
            <label className="relative flex-[1.3]">
              <span className="sr-only">วันที่</span>
              <IconCalendar className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-ink-2" />
              <input type="date" className={`${inputClass} pl-10`} value={form.dueDate} disabled={submitting}
                onChange={(e) => set({ dueDate: e.target.value })} />
            </label>
            <label className="relative flex-1">
              <span className="sr-only">เวลา</span>
              <IconClock className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-ink-2" />
              <input type="time" className={`${inputClass} pl-10`} value={form.dueTime} disabled={submitting}
                onChange={(e) => set({ dueTime: e.target.value })} />
            </label>
          </div>
        </div>
      </div>

      <AssigneeSheet
        open={picking}
        subtitle={form.title}
        members={load.data.members}
        value={form.assignee}
        onClose={() => setPicking(false)}
        onConfirm={(lineUserId) => {
          set({ assignee: lineUserId })
          setPicking(false)
        }}
      />
    </Page>
  )
}
