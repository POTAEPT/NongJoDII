'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { QUARTER_HOURS, SETUP_DEFAULTS, WEEKDAYS, WORK_DESCRIPTION_MAX } from '@/server/setup/rules'
import type { SetupFeatures, SetupLoad, SetupSubmitResult } from '@/server/setup/types'
import type { LiffViewProps } from './liff-sdk'
import {
  addNickname, initialSetupForm, removeNickname, setNickname, setRole, SETUP_STEPS, toSubmitBody, validateAll,
  validateStep, type SetupForm,
} from './setup-model'

// #52 setup form, Figma v4 #2b-#2d2: four steps with next and back, then one send. `id`
// is groups.id. Only the LIFF ID token goes up as identity.

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงตั้งค่ากลุ่มไม่ได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_409 = 'กลุ่มนี้ตั้งค่าเสร็จแล้ว เปลี่ยนการตั้งค่าได้ในหน้าตั้งค่า'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404) return ERR_404
  if (status === 409) return ERR_409
  if (status === 400) return ERR_400
  return fallback
}

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

const FEATURES: { key: keyof SetupFeatures; label: string; sub: string }[] = [
  { key: 'summarize', label: 'สรุปงานจากแชต', sub: 'ร่างงานให้ทีมกดยืนยัน' },
  { key: 'saveFiles', label: 'เก็บไฟล์ลง Google Drive', sub: 'ไฟล์ในแชตไปอยู่โฟลเดอร์ของกลุ่ม' },
  { key: 'trackRemind', label: 'ติดตามงาน + เตือน', sub: 'ถามปิดงาน และเตือนงานใกล้ครบกำหนด' },
  { key: 'weeklySummary', label: 'สรุปรายสัปดาห์', sub: 'โพสต์สรุปในกลุ่มทุกสัปดาห์' },
]

const STEP_TITLES = [
  { title: 'กลุ่มนี้ทำเรื่องอะไร?', sub: 'เล่าสั้น ๆ เพื่อให้ NongJoDII เข้าใจกลุ่ม' },
  { title: 'ใครทำหน้าที่อะไร?', sub: 'ชื่อเล่นช่วยให้ NongJoDII รู้ว่าแชตพูดถึงใคร' },
  { title: 'อยากให้ NongJoDII ช่วยอะไร?', sub: 'เลือกได้หลายข้อ' },
  { title: 'ให้ NongJoDII เตือนตอนไหน?', sub: 'เวลาประเทศไทย' },
]

function TimeSelect({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <select
      className="mt-1 w-full rounded border p-2"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {QUARTER_HOURS.map((t) => (
        <option key={t} value={t}>{t}</option>
      ))}
    </select>
  )
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SetupLoad }

export function SetupView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<SetupForm | null>(null)
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState<SetupSubmitResult | null>(null)
  const started = useRef(false)
  const inFlight = useRef(false) // blocks a double send before state re-renders

  const fetchSetup = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/setup/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, ERR_LOAD) })
      const data = json as SetupLoad
      setForm(initialSetupForm(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchSetup()
  }, [fetchSetup])

  const send = async () => {
    if (!form || inFlight.current) return
    const problem = validateAll(form)
    if (problem) {
      setStep(problem.step)
      return setFormError(problem.message)
    }
    inFlight.current = true
    setFormError(null)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/setup/submit', { idToken, groupId: id, ...toSubmitBody(form) })
      if (status === 200) setDone(json as SetupSubmitResult)
      else setFormError(errorCopy(status, ERR_SUBMIT))
    } catch {
      setFormError(ERR_SUBMIT)
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
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchSetup()}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  const { data } = load
  const close = (
    <button type="button" className="mt-4 w-full rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
      กลับไปที่แชท
    </button>
  )
  if (data.state === 'confirmed' || data.state === 'in_project') {
    return <div className="p-4 text-base"><p>{ERR_409}</p>{close}</div>
  }
  if (done) {
    const owner = form?.members.find((m) => m.lineUserId === form.ownerLineUserId)
    return (
      <div className="p-4 text-base">
        <h1 className="text-lg font-bold">ตั้งค่าเสร็จแล้ว ✓</h1>
        {done.state === 'pending_owner' && owner && (
          <p className="mt-2">รอ {owner.displayName} ยืนยันเป็นเจ้าของบอท จากการ์ดในกลุ่ม</p>
        )}
        {done.posted !== 'pushed' && <p className="mt-2 text-sm text-gray-600">บันทึกแล้ว แต่แจ้งในกลุ่มไม่สำเร็จ</p>}
        {close}
      </div>
    )
  }
  if (!form) return null

  const set = (next: SetupForm) => {
    setFormError(null)
    setForm(next)
  }
  const go = (to: number) => {
    if (to > step) {
      const message = validateStep(form, step)
      if (message) return setFormError(message)
    }
    setFormError(null)
    setStep(to)
  }
  const head = STEP_TITLES[step - 1]

  return (
    <div className="p-4 text-base">
      <p className="text-sm text-gray-600">ขั้นที่ {step}/{SETUP_STEPS}{data.groupName ? ` · ${data.groupName}` : ''}</p>
      <h1 className="mt-1 text-lg font-bold">{head.title}</h1>
      <p className="text-sm text-gray-600">{head.sub}</p>

      {step === 1 && (
        <label className="mt-4 block">
          <textarea
            maxLength={WORK_DESCRIPTION_MAX}
            rows={6}
            className="w-full rounded border p-2"
            value={form.workDescription}
            disabled={submitting}
            onChange={(e) => set({ ...form, workDescription: e.target.value })}
          />
          <span className="text-xs text-gray-500">{form.workDescription.length}/{WORK_DESCRIPTION_MAX}</span>
        </label>
      )}

      {step === 2 && (
        <div className="mt-4 space-y-3">
          {form.members.map((m) => (
            <section key={m.lineUserId} className="space-y-2 rounded border p-3">
              <div className="flex items-center justify-between">
                <span className="font-bold">{m.displayName}</span>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="radio"
                    name="owner"
                    checked={form.ownerLineUserId === m.lineUserId}
                    disabled={submitting}
                    onChange={() => set({ ...form, ownerLineUserId: m.lineUserId })}
                  />
                  เจ้าของบอท
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {m.nicknames.map((n, i) => (
                  <span key={i} className="flex items-center rounded-full border px-2">
                    <input
                      type="text"
                      aria-label="ชื่อเล่น"
                      maxLength={50}
                      className="w-24 bg-transparent p-1 text-sm"
                      value={n}
                      disabled={submitting}
                      onChange={(e) => set(setNickname(form, m.lineUserId, i, e.target.value))}
                    />
                    <button
                      type="button"
                      aria-label="ลบชื่อเล่น"
                      className="px-1 text-gray-500"
                      disabled={submitting}
                      onClick={() => set(removeNickname(form, m.lineUserId, i))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="rounded-full border border-dashed px-3 py-1 text-sm text-blue-700"
                  disabled={submitting}
                  onClick={() => set(addNickname(form, m.lineUserId))}
                >
                  + ชื่อเล่น
                </button>
              </div>
              <label className="block">
                <span className="text-sm">หน้าที่</span>
                <input
                  type="text"
                  maxLength={100}
                  className="mt-1 w-full rounded border p-2"
                  value={m.role}
                  disabled={submitting}
                  onChange={(e) => set(setRole(form, m.lineUserId, e.target.value))}
                />
              </label>
            </section>
          ))}
          <p className="text-xs text-gray-500">
            เจ้าของบอทต้องกดยืนยันเองด้วยบัญชี LINE ก่อนจึงจะมีผล ชื่อเล่นใช้ให้ NongJoDII อ่านแชตเท่านั้น
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4 space-y-2">
          {FEATURES.map((f) => (
            <label key={f.key} className="flex items-start gap-3 rounded border p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={form.features[f.key]}
                disabled={submitting}
                onChange={(e) => set({ ...form, features: { ...form.features, [f.key]: e.target.checked } })}
              />
              <span>
                <span className="block font-bold">{f.label}</span>
                <span className="block text-sm text-gray-600">{f.sub}</span>
              </span>
            </label>
          ))}
        </div>
      )}

      {step === 4 && (
        <div className="mt-4 space-y-4">
          <section className="rounded border p-3">
            <span className="text-sm font-bold">เตือนงานทุกวัน</span>
            <TimeSelect
              value={form.dailyReminderTime}
              disabled={submitting}
              onChange={(v) => set({ ...form, dailyReminderTime: v })}
            />
            <p className="mt-1 text-xs text-gray-500">
              เลื่อนเลือกเวลา ทีละ 15 นาที · ค่าเริ่มต้น {SETUP_DEFAULTS.dailyReminderTime}
            </p>
          </section>
          <section className="rounded border p-3">
            <span className="text-sm font-bold">โพสต์สรุปในกลุ่มทุกสัปดาห์</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.iso}
                  type="button"
                  aria-pressed={form.weeklySummaryWeekday === d.iso}
                  className={`rounded-full border px-3 py-1 text-sm ${form.weeklySummaryWeekday === d.iso ? 'bg-blue-700 text-white' : ''}`}
                  disabled={submitting}
                  onClick={() => set({ ...form, weeklySummaryWeekday: d.iso })}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <TimeSelect
              value={form.weeklySummaryTime}
              disabled={submitting}
              onChange={(v) => set({ ...form, weeklySummaryTime: v })}
            />
          </section>
          <p className="text-xs text-gray-500">เปลี่ยนได้ทุกเมื่อในตั้งค่า</p>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {formError && <p role="alert">{formError}</p>}
        <div className="flex gap-2">
          {step > 1 && (
            <button type="button" className="flex-1 rounded border px-4 py-2" disabled={submitting} onClick={() => go(step - 1)}>
              ย้อนกลับ
            </button>
          )}
          {step < SETUP_STEPS ? (
            <button type="button" className="flex-1 rounded border px-4 py-2 font-bold" disabled={submitting} onClick={() => go(step + 1)}>
              ถัดไป
            </button>
          ) : (
            <button type="button" className="flex-1 rounded border px-4 py-2 font-bold" disabled={submitting} onClick={() => void send()}>
              {submitting ? 'กำลังส่ง...' : 'ส่ง'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
