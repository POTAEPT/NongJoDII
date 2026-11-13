'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskView as TaskData } from '@/server/tasks/load'
import { post } from './api'
import { splitBangkokIso, toBangkokIso } from './form-model'
import type { LiffViewProps } from './liff-sdk'

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงแก้ไขงานไม่ได้'
const ERR_404 = 'ไม่พบงานนี้'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_OTHER = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404) return ERR_404
  if (status === 400) return ERR_400
  return ERR_OTHER
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: TaskData }
type Form = { title: string; details: string; assignee: string; dueDate: string; dueTime: string }

function toForm(t: TaskData): Form {
  const { date, time } = splitBangkokIso(t.dueAt)
  return { title: t.title, details: t.details ?? '', assignee: t.assigneeLineUserId ?? '', dueDate: date, dueTime: time }
}

export function TaskView({ idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<Form | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double submit before state re-renders

  const fetchTask = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/tasks/load', { idToken, taskId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status) })
      const data = json as TaskData
      setForm(toForm(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', message: ERR_OTHER })
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
    setSaved(false)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/tasks/update', {
        idToken,
        taskId: id,
        title: form.title.trim(),
        details: form.details === '' ? null : form.details,
        assigneeLineUserId: form.assignee === '' ? null : form.assignee,
        dueAt: toBangkokIso(form.dueDate, form.dueTime),
      })
      if (status !== 200) setFormError(errorCopy(status))
      else {
        setForm(toForm(json as TaskData))
        setSaved(true)
      }
    } catch {
      setFormError(ERR_OTHER)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  if (load.kind === 'loading') return <p className="p-4 text-base">กำลังโหลด...</p>
  if (load.kind === 'error') {
    return (
      <div className="p-4 text-base">
        <p>{load.message}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchTask()}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  if (!form) return null

  const set = (patch: Partial<Form>) => {
    setSaved(false)
    setForm({ ...form, ...patch })
  }

  return (
    <div className="p-4 text-base">
      <h1 className="text-lg font-bold">แก้ไขงาน</h1>
      <section className="mt-4 space-y-2 rounded border p-3">
        <label className="block">
          <span className="text-sm">ชื่องาน</span>
          <input
            type="text"
            maxLength={200}
            className="mt-1 w-full rounded border p-2"
            value={form.title}
            disabled={submitting}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="text-sm">รายละเอียด</span>
          <textarea
            maxLength={2000}
            rows={3}
            className="mt-1 w-full rounded border p-2"
            value={form.details}
            disabled={submitting}
            onChange={(e) => set({ details: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="text-sm">ผู้รับผิดชอบ</span>
          <select
            className="mt-1 w-full rounded border p-2"
            value={form.assignee}
            disabled={submitting}
            onChange={(e) => set({ assignee: e.target.value })}
          >
            <option value="">ยังไม่มีผู้รับ</option>
            {load.data.members.map((m) => (
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
              value={form.dueDate}
              disabled={submitting}
              onChange={(e) => set({ dueDate: e.target.value })}
            />
          </label>
          <label className="block flex-1">
            <span className="text-sm">เวลา</span>
            <input
              type="time"
              className="mt-1 w-full rounded border p-2"
              value={form.dueTime}
              disabled={submitting}
              onChange={(e) => set({ dueTime: e.target.value })}
            />
          </label>
        </div>
      </section>
      <div className="mt-4 space-y-2">
        {formError && <p role="alert">{formError}</p>}
        {saved && <p role="status">บันทึกแล้ว</p>}
        <button
          type="button"
          className="w-full rounded border px-4 py-2 font-bold"
          disabled={submitting}
          onClick={() => void save()}
        >
          บันทึก
        </button>
      </div>
    </div>
  )
}
