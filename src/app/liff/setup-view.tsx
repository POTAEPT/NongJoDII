'use client'

import { TAG_SET_MAX } from '@/server/tasks/tags'
import { TagsEditor } from './tags-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import { liffUrl } from '@/server/liff-links'
import { NICKNAME_MAX, ROLE_MAX, SETUP_DEFAULTS, WEEKDAYS, WORK_DESCRIPTION_MAX } from '@/server/setup/rules'
import type { SetupLoad, SetupResendResult, SetupSubmitResult } from '@/server/setup/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { FEATURES, TimeSelect } from './setup-parts'
import {
  addNickname, initialSetupForm, removeNickname, setNickname, setRole, SETUP_STEPS, stepForField, toSubmitBody,
  submitView, validateAll, validateStep, type SetupForm,
} from './setup-model'
import { Avatar, Button, Field, IconCheck, IconPlus, Notice, Page, StatusScreen, inputClass } from './ui'

// #52 setup form, Figma UI v4 #2b-#2d: four steps with back and next, then one send. `id`
// is groups.id. Only the LIFF ID token goes up as identity.

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้ จึงตั้งค่ากลุ่มไม่ได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_409 = 'กลุ่มนี้ตั้งค่าเสร็จแล้ว เปลี่ยนการตั้งค่าได้ในหน้าตั้งค่า'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SUBMIT = 'ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่'

/** The done screen's note when the #2e card did not reach the group. */
const POSTED_NOTE: Partial<Record<SetupSubmitResult['posted'], string>> = {
  skipped_quota: 'บันทึกแล้ว แต่เดือนนี้แจ้งในกลุ่มไม่ได้ (โควตาข้อความใกล้หมด)',
  failed: 'บันทึกแล้ว แต่แจ้งในกลุ่มไม่สำเร็จ',
}

function errorCopy(status: number, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return ERR_403
  if (status === 404) return ERR_404
  if (status === 409) return ERR_409
  if (status === 400) return ERR_400
  return fallback
}

const STEP_TITLES = [
  { title: 'กลุ่มนี้ทำเรื่องอะไร?', sub: 'เล่าสั้น ๆ เพื่อให้น้องจดดีเข้าใจกลุ่ม' },
  { title: 'ใครทำหน้าที่อะไร?', sub: 'ชื่อเล่นช่วยให้น้องจดดีรู้ว่าแชตพูดถึงใคร' },
  { title: 'อยากให้น้องจดดีช่วยอะไร?', sub: 'เลือกได้หลายข้อ' },
  { title: 'ให้น้องจดดีเตือนตอนไหน?', sub: 'เวลาประเทศไทย' },
]

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SetupLoad }

export function SetupView({ liff, idToken, liffId, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<SetupForm | null>(null)
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [done, setDone] = useState<SetupSubmitResult | null>(null)
  /** #30: the submit answered needs_drive (a claim waiting for Drive) or owner_needed. */
  const [ownerFlow, setOwnerFlow] = useState<'needs_drive' | 'owner_needed' | null>(null)
  /** The nominee a resend reported: the saved one, which may differ from this page's form. */
  const [resentOwnerName, setResentOwnerName] = useState<string | null>(null)
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
      const view = submitView(status, json)
      if (view === 'needs_drive' || view === 'owner_needed') setOwnerFlow(view)
      else if (view === 'done') setDone(json as SetupSubmitResult)
      else {
        // A 400 names the refused field: its message goes on the step that owns it.
        const problem = status === 400 ? stepForField((json as { field?: unknown } | null)?.field) : null
        if (problem) setStep(problem.step)
        setFormError(problem ? problem.message : errorCopy(status, ERR_SUBMIT))
      }
    } catch {
      setFormError(ERR_SUBMIT)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  /** Pushes the card again for the nomination the group holds now. Saves nothing: this
   *  page's form may be stale, and sending it again would undo another Member's changes. */
  const resend = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setFormError(null)
    setSubmitting(true)
    try {
      const { status, json } = await post('/api/setup/resend-card', { idToken, groupId: id })
      if (status === 200) {
        const r = json as SetupResendResult
        setResentOwnerName(r.ownerName)
        setDone({ state: r.state, posted: r.posted })
      } else setFormError(errorCopy(status, ERR_SUBMIT))
    } catch {
      setFormError(ERR_SUBMIT)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const close = () => liff.closeWindow()
  const TITLE = 'ตั้งค่ากลุ่ม'
  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchSetup()} onClose={close} />
    )
  }
  const { data } = load
  // #30: the Owner of this group left (for example a Sub group that detached): the Owner role
  // goes through the Owner page, which asks for Google Drive before it takes effect.
  if (ownerFlow === 'needs_drive' && id) {
    // Never the done screen: the role waits for the person's Google Drive.
    return (
      <Page title={TITLE} onBack={close}
        bottom={
          <div className="space-y-2">
            <a className="flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-base font-semibold text-white"
              href={liffUrl(liffId, 'google')}>เชื่อม Google Drive</a>
            <a className="flex min-h-12 w-full items-center justify-center rounded-xl border border-line px-4 text-base font-semibold text-primary"
              href={liffUrl(liffId, 'owner', id)}>ไปหน้าเจ้าของบอท</a>
          </div>
        }>
        <div className="pt-6 text-center">
          <h2 className="text-[22px] font-semibold leading-snug">อีกขั้นเดียว เชื่อม Google Drive ของคุณ</h2>
          <p className="mt-2 text-sm text-ink-2">คุณจะเป็นเจ้าของบอทของกลุ่มนี้เมื่อเชื่อม Google Drive ของตัวเองแล้ว ยังไม่ได้บันทึกการตั้งค่าในฟอร์มนี้ แก้ได้ในหน้าตั้งค่าเมื่อเป็นเจ้าของบอทแล้ว</p>
        </div>
      </Page>
    )
  }
  if ((data.ownerNeeded || ownerFlow === 'owner_needed') && id) {
    return (
      <Page title={TITLE} onBack={close}
        bottom={
          <a className="flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-base font-semibold text-white"
            href={liffUrl(liffId, 'owner', id)}>เป็นเจ้าของบอทแทน</a>
        }>
        <div className="pt-6 text-center">
          <h2 className="text-[22px] font-semibold leading-snug">กลุ่มนี้ยังไม่มีเจ้าของบอท</h2>
          <p className="mt-2 text-sm text-ink-2">เจ้าของบอทคนใหม่ยืนยันด้วย LINE แล้วเชื่อม Google Drive ของตัวเอง จากนั้นแก้การตั้งค่าได้ในหน้าตั้งค่า</p>
        </div>
      </Page>
    )
  }
  if (data.state === 'confirmed' || data.state === 'in_project') {
    return <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="ตั้งค่าเสร็จแล้ว" message={ERR_409} onClose={close} />
  }
  if (done) {
    const ownerName = resentOwnerName ?? form?.members.find((m) => m.lineUserId === form.ownerLineUserId)?.displayName
    // Only a pending nomination can be sent again: a confirmed group answers 409.
    const retryCard = done.state === 'pending_owner' && done.posted === 'failed'
    return (
      <Page title={TITLE} onBack={close} bottom={
        <div className="space-y-2">
          {retryCard && (
            // The server pushes the card for the saved nomination under its own retry key,
            // without saving this page's form again.
            <Button disabled={submitting} onClick={() => void resend()}>
              {submitting ? 'กำลังส่ง...' : 'ส่งการ์ดยืนยันอีกครั้ง'}
            </Button>
          )}
          <Button variant={retryCard ? 'outline' : 'primary'} onClick={close}>กลับไปที่แชต</Button>
        </div>
      }>
        <div className="flex flex-col items-center pt-8 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-done-bg text-done"><IconCheck className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">ตั้งค่าเสร็จแล้ว</h2>
          <p className="mt-1 text-sm text-ink-2">น้องจดดีรู้จักกลุ่มและทีมแล้ว จากนี้จะอ่านแชตและร่างงานให้กดยืนยันนะ</p>
        </div>
        <div className="mt-6 space-y-2">
          {done.state === 'pending_owner' && ownerName && done.posted === 'pushed' && (
            <Notice tone="info">รอ {ownerName} ยืนยันเป็นเจ้าของบอท จากการ์ดในกลุ่ม</Notice>
          )}
          {POSTED_NOTE[done.posted] && <Notice tone="info">{POSTED_NOTE[done.posted]}</Notice>}
          {formError && <Notice>{formError}</Notice>}
        </div>
      </Page>
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
    <Page
      title={data.groupName ? `${TITLE} · ${data.groupName}` : TITLE}
      onBack={close}
      bottom={
        <div className="space-y-2">
          {formError && <Notice>{formError}</Notice>}
          <div className="flex gap-2">
            {step > 1 && (
              <Button variant="secondary" disabled={submitting} onClick={() => go(step - 1)}>ย้อนกลับ</Button>
            )}
            {step < SETUP_STEPS ? (
              <Button disabled={submitting} onClick={() => go(step + 1)}>ต่อไป</Button>
            ) : (
              <Button disabled={submitting} onClick={() => void send()}>{submitting ? 'กำลังส่ง...' : 'เสร็จสิ้น'}</Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex items-center gap-2" aria-label={`ข้อ ${step} จาก ${SETUP_STEPS}`}>
        {Array.from({ length: SETUP_STEPS }, (_, i) => (
          <span key={i} className={`h-2 rounded-full ${i + 1 === step ? 'w-6' : 'w-2'} ${i < step ? 'bg-primary' : 'bg-line'}`} />
        ))}
        <span className="text-xs text-ink-3">ข้อ {step} จาก {SETUP_STEPS}</span>
      </div>
      <h2 className="mt-3 text-[22px] font-semibold leading-snug">{head.title}</h2>
      <p className="mt-1 text-sm text-ink-2">{head.sub}</p>

      {step === 1 && (
        <div className="mt-4">
          <Field label="เรื่องของกลุ่ม">
            <textarea
              maxLength={WORK_DESCRIPTION_MAX}
              rows={6}
              className={inputClass}
              placeholder="พิมพ์ที่นี่"
              value={form.workDescription}
              disabled={submitting}
              onChange={(e) => set({ ...form, workDescription: e.target.value })}
            />
          </Field>
          <p className="mt-1 text-right text-xs text-ink-3">{form.workDescription.length}/{WORK_DESCRIPTION_MAX}</p>
          {/* #110: the group's starting tags; the step can be left empty. */}
          <div className="mt-4">
            <Field label="แท็กของกลุ่ม (ไม่บังคับ)">
              <TagsEditor tags={form.tagSet} max={TAG_SET_MAX} disabled={submitting}
                onChange={(tagSet) => set({ ...form, tagSet })} />
            </Field>
            <p className="mt-1 text-xs text-ink-3">น้องจดดีจะเลือกแท็กจากชุดนี้ก่อนเวลาสรุปงาน แก้ได้ในหน้าตั้งค่า</p>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4 space-y-3">
          {form.members.map((m) => {
            const owner = form.ownerLineUserId === m.lineUserId
            return (
              <section key={m.lineUserId} className="space-y-3 rounded-2xl border border-line bg-page p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={m.displayName} id={m.lineUserId} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{m.displayName}</p>
                    <p className="text-xs text-ink-3">ชื่อใน LINE</p>
                  </div>
                  <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${owner ? 'bg-primary text-white' : 'bg-primary-soft text-primary'}`}>
                    <input
                      type="radio"
                      name="owner"
                      className="sr-only"
                      checked={owner}
                      disabled={submitting}
                      onChange={() => set({ ...form, ownerLineUserId: m.lineUserId })}
                    />
                    {owner && <IconCheck className="h-3.5 w-3.5" />}
                    เจ้าของบอท
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  {m.nicknames.map((n, i) => (
                    <span key={i} className="flex items-center rounded-full border border-line bg-subtle pl-3 pr-1">
                      <input
                        type="text"
                        aria-label="ชื่อเล่น"
                        placeholder="ชื่อเล่น"
                        maxLength={NICKNAME_MAX}
                        className="w-24 bg-transparent py-1 text-sm focus:outline-none"
                        value={n}
                        disabled={submitting}
                        onChange={(e) => set(setNickname(form, m.lineUserId, i, e.target.value))}
                      />
                      <button
                        type="button"
                        aria-label="ลบชื่อเล่น"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3"
                        disabled={submitting}
                        onClick={() => set(removeNickname(form, m.lineUserId, i))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-sm font-semibold text-primary"
                    disabled={submitting}
                    onClick={() => set(addNickname(form, m.lineUserId))}
                  >
                    <IconPlus className="h-3.5 w-3.5" /> ชื่อเล่น
                  </button>
                </div>
                <Field label="หน้าที่">
                  <input
                    type="text"
                    maxLength={ROLE_MAX}
                    className={inputClass}
                    placeholder="เช่น Design, PM, Dev"
                    value={m.role}
                    disabled={submitting}
                    onChange={(e) => set(setRole(form, m.lineUserId, e.target.value))}
                  />
                </Field>
              </section>
            )
          })}
          <p className="text-xs text-ink-3">
            เจ้าของบอทต้องกดยืนยันเองด้วยบัญชี LINE ก่อนจึงจะมีผล ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น
          </p>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4 space-y-3">
          {FEATURES.map((f) => {
            const on = form.features[f.key]
            return (
              <label key={f.key}
                className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 ${on ? 'border-primary bg-primary-soft' : 'border-line bg-page'}`}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={on}
                  disabled={submitting}
                  onChange={(e) => set({ ...form, features: { ...form.features, [f.key]: e.target.checked } })}
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{f.label}</span>
                  <span className="block text-xs text-ink-3">{f.sub}</span>
                </span>
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-primary bg-primary text-white' : 'border-line-strong'}`}>
                  {on && <IconCheck className="h-4 w-4" />}
                </span>
              </label>
            )
          })}
        </div>
      )}

      {step === 4 && (
        <div className="mt-4 space-y-3">
          <section className="space-y-2 rounded-2xl border border-line bg-page p-4">
            <Field label="เตือนงานทุกวัน">
              <TimeSelect
                value={form.dailyReminderTime}
                disabled={submitting}
                onChange={(v) => set({ ...form, dailyReminderTime: v })}
              />
            </Field>
            <p className="text-xs text-ink-3">เลือกเวลาได้ทีละ 15 นาที · ค่าเริ่มต้น {SETUP_DEFAULTS.dailyReminderTime}</p>
          </section>
          <section className="space-y-3 rounded-2xl border border-line bg-page p-4">
            <span className="block text-sm font-semibold">โพสต์สรุปในกลุ่มทุกสัปดาห์</span>
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => {
                const on = form.weeklySummaryWeekday === d.iso
                return (
                  <button
                    key={d.iso}
                    type="button"
                    aria-pressed={on}
                    className={`rounded-full px-4 py-1.5 text-sm font-semibold ${on ? 'bg-primary text-white' : 'border border-line bg-page text-ink-2'}`}
                    disabled={submitting}
                    onClick={() => set({ ...form, weeklySummaryWeekday: d.iso })}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
            <TimeSelect
              value={form.weeklySummaryTime}
              disabled={submitting}
              onChange={(v) => set({ ...form, weeklySummaryTime: v })}
            />
          </section>
          <p className="text-xs text-ink-3">เปลี่ยนได้ทุกเมื่อในตั้งค่า</p>
        </div>
      )}
    </Page>
  )
}
