'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NICKNAME_MAX, ROLE_MAX, WEEKDAYS, WORK_DESCRIPTION_MAX } from '@/server/setup/rules'
import { formatThaiDateLong } from '@/server/time/bangkok'
import type { SettingsLoad } from '@/server/settings/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Avatar, Button, Chip, Field, IconCheck, IconLock, IconPlus, Notice, Page, StatusScreen, inputClass } from './ui'
import { initialSettingsForm, settingsFieldMessage, toSettingsBody, validateSettings } from './settings-model'
import { FEATURES, TimeSelect } from './setup-parts'
import { addNickname, removeNickname, setNickname, setRole, type SetupForm } from './setup-model'

// #28 Settings, opened from the "น้องจดดี ตั้งค่า" card. `id` is groups.id. Two tabs:
// the group's settings (the confirmed Owner edits, everyone else looks) and a static plan
// mock with no payment. The Owner can also Stop using (#11): after a confirm step the bot
// leaves the group, and its data is deleted 7 days later unless the bot is invited back.
// Changing the Owner (#30, #31) comes later.

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้'
const ERR_NOT_OWNER = 'เฉพาะเจ้าของบอทของกลุ่มนี้เท่านั้นที่แก้การตั้งค่าได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SAVE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'
const ERR_STOP = 'น้องจดดียังออกจากกลุ่มไม่ได้ กรุณาลองใหม่'

function errorCopy(status: number, json: unknown, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return (json as { error?: string } | null)?.error === 'not_owner' ? ERR_NOT_OWNER : ERR_403
  if (status === 404) return ERR_404
  if (status === 400) return settingsFieldMessage((json as { field?: unknown } | null)?.field) ?? ERR_400
  return fallback
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SettingsLoad }
type Tab = 'settings' | 'plans'
/** Stop using: idle, the confirm step, the call in flight, or done with the delete date. */
type Stop = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'leaving' } | { kind: 'done'; deleteAfter: string | null }

export function SettingsView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<SetupForm | null>(null)
  const [tab, setTab] = useState<Tab>('settings')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [stop, setStop] = useState<Stop>({ kind: 'idle' })
  const [stopError, setStopError] = useState<string | null>(null)
  const started = useRef(false)
  const inFlight = useRef(false)

  const fetchSettings = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/settings/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, json, ERR_LOAD) })
      const data = json as SettingsLoad
      setForm(initialSettingsForm(data))
      setLoad({ kind: 'ready', data })
    } catch {
      setLoad({ kind: 'error', message: ERR_LOAD })
    }
  }, [idToken, id])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not load twice
    started.current = true
    void fetchSettings()
  }, [fetchSettings])

  const save = async () => {
    if (!form || inFlight.current) return
    const problem = validateSettings(form)
    if (problem) return setError(problem)
    inFlight.current = true
    setError(null)
    setSaving(true)
    try {
      const { status, json } = await post('/api/settings/submit', { idToken, groupId: id, ...toSettingsBody(form) })
      if (status === 200) setSaved(true)
      else setError(errorCopy(status, json, ERR_SAVE))
    } catch {
      setError(ERR_SAVE)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  const stopUsing = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setStopError(null)
    setStop({ kind: 'leaving' })
    try {
      const { status, json } = await post('/api/settings/stop-using', { idToken, groupId: id, confirm: true })
      if (status === 200) return setStop({ kind: 'done', deleteAfter: (json as { deleteAfter: string | null }).deleteAfter })
      setStopError(errorCopy(status, json, ERR_STOP))
      setStop({ kind: 'confirm' })
    } catch {
      setStopError(ERR_STOP)
      setStop({ kind: 'confirm' })
    } finally {
      inFlight.current = false
    }
  }

  const close = () => liff.closeWindow()
  const TITLE = 'ตั้งค่า'
  if (load.kind === 'loading') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังโหลด..." />
  if (load.kind === 'error') {
    return (
      <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="โหลดข้อมูลไม่สำเร็จ" message={load.message}
        onRetry={() => void fetchSettings()} onClose={close} />
    )
  }
  const { data } = load
  if (stop.kind === 'done') {
    const date = stop.deleteAfter ? formatThaiDateLong(new Date(stop.deleteAfter)) : null
    return (
      <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="น้องจดดีออกจากกลุ่มแล้ว"
        message={`ข้อมูลของกลุ่มนี้จะถูกลบ${date ? `วันที่ ${date}` : 'ใน 7 วัน'} ถ้าเชิญน้องจดดีกลับเข้ากลุ่มก่อนวันนั้น ข้อมูลจะกลับมาครบ ไฟล์ใน Google Drive ของเจ้าของบอทยังอยู่ ไม่ถูกลบ`}
        onClose={close} />
    )
  }
  if (data.state === 'not_set_up') {
    return (
      <StatusScreen kind="forbidden" appTitle={TITLE} onBack={close} title="กลุ่มนี้ยังตั้งค่าไม่เสร็จ"
        message={'กรุณาใช้ปุ่ม "ตั้งค่ากลุ่ม" ในการ์ดที่น้องจดดีส่งในกลุ่ม'} onClose={close} />
    )
  }
  if (!form) return null

  const ro = !data.canEdit || saving
  const set = (next: SetupForm) => {
    setError(null)
    setSaved(false)
    setForm(next)
  }
  const editing = tab === 'settings' && data.canEdit

  return (
    <Page
      title={data.groupName ? `${TITLE} · ${data.groupName}` : TITLE}
      onBack={close}
      bottom={editing ? (
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          {saved && <Notice tone="success">บันทึกแล้ว</Notice>}
          <Button disabled={saving} onClick={() => void save()}>{saving ? 'กำลังบันทึก...' : 'บันทึก'}</Button>
        </div>
      ) : <Button variant="outline" onClick={close}>กลับไปที่แชต</Button>}
    >
      <div className="flex gap-1 rounded-full bg-line p-1" role="tablist">
        {(['settings', 'plans'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`flex-1 rounded-full px-3 py-2 text-sm font-semibold ${tab === t ? 'bg-page text-ink shadow-sm' : 'text-ink-2'}`}
            onClick={() => setTab(t)}
          >
            {t === 'settings' ? 'ตั้งค่ากลุ่ม' : 'แพ็กเกจ'}
          </button>
        ))}
      </div>

      {tab === 'plans' ? <Plans /> : (
        <div className="mt-4 space-y-4">
          <section className="flex items-center gap-3 rounded-2xl border border-line bg-page p-4">
            {data.owner
              ? <Avatar name={data.owner.displayName} id={data.owner.displayName} size="md" />
              : <span className="flex h-9 w-9 items-center justify-center rounded-full bg-line text-ink-3"><IconLock className="h-4 w-4" /></span>}
            <div className="min-w-0">
              <p className="text-xs text-ink-3">เจ้าของบอท</p>
              <p className="truncate font-semibold">{data.owner?.displayName ?? '-'}</p>
            </div>
          </section>
          {!data.canEdit && <Notice tone="info">{ERR_NOT_OWNER} คุณดูได้อย่างเดียว</Notice>}

          <Field label="กลุ่มนี้ทำเรื่องอะไร">
            <textarea
              maxLength={WORK_DESCRIPTION_MAX}
              rows={4}
              className={inputClass}
              value={form.workDescription}
              disabled={ro}
              onChange={(e) => set({ ...form, workDescription: e.target.value })}
            />
          </Field>

          <section className="space-y-2">
            <span className="block text-sm font-semibold">{data.canEdit ? 'ชื่อเล่นและหน้าที่' : 'สมาชิก'}</span>
            {form.members.map((m) => (
              <div key={m.lineUserId} className="space-y-3 rounded-2xl border border-line bg-page p-4">
                <div className="flex items-center gap-3">
                  <Avatar name={m.displayName} id={m.lineUserId} size="md" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{m.displayName}</span>
                  {!data.canEdit && m.role && <Chip>{m.role}</Chip>}
                </div>
                {data.canEdit && (
                  <>
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
                            disabled={ro}
                            onChange={(e) => set(setNickname(form, m.lineUserId, i, e.target.value))}
                          />
                          <button
                            type="button"
                            aria-label="ลบชื่อเล่น"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3"
                            disabled={ro}
                            onClick={() => set(removeNickname(form, m.lineUserId, i))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-sm font-semibold text-primary"
                        disabled={ro}
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
                        value={m.role}
                        disabled={ro}
                        onChange={(e) => set(setRole(form, m.lineUserId, e.target.value))}
                      />
                    </Field>
                  </>
                )}
              </div>
            ))}
            <p className="text-xs text-ink-3">ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE</p>
          </section>

          <section className="space-y-2">
            <span className="block text-sm font-semibold">ฟีเจอร์</span>
            {FEATURES.map((f) => {
              const on = form.features[f.key]
              return (
                <label key={f.key}
                  className={`flex items-center gap-3 rounded-xl border p-4 ${ro ? '' : 'cursor-pointer'} ${on ? 'border-primary bg-primary-soft' : 'border-line bg-page'}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    disabled={ro}
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
          </section>

          <section className="space-y-2 rounded-2xl border border-line bg-page p-4">
            <Field label="เตือนงานทุกวัน">
              <TimeSelect value={form.dailyReminderTime} disabled={ro} onChange={(v) => set({ ...form, dailyReminderTime: v })} />
            </Field>
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
                    disabled={ro}
                    onClick={() => set({ ...form, weeklySummaryWeekday: d.iso })}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
            <TimeSelect value={form.weeklySummaryTime} disabled={ro} onChange={(v) => set({ ...form, weeklySummaryTime: v })} />
          </section>
          <p className="text-xs text-ink-3">
            เวลาเป็นเวลาประเทศไทย เปลี่ยนแล้วมีผลในรอบถัดไป ถ้าวันนี้เตือนไปแล้ว เวลาใหม่จะเริ่มพรุ่งนี้
          </p>

          {data.canEdit && (
            <section className="space-y-3 rounded-2xl border border-line bg-page p-4">
              <span className="block text-sm font-semibold">เลิกใช้น้องจดดีในกลุ่มนี้</span>
              <p className="text-xs text-ink-3">
                น้องจดดีจะออกจากกลุ่ม และลบข้อมูลของกลุ่มนี้ (แชตที่เก็บไว้ งาน และสรุป) ใน 7 วัน
                ถ้าเชิญกลับภายใน 7 วัน ข้อมูลจะกลับมาครบ ไฟล์ใน Google Drive ไม่ถูกลบ
              </p>
              {stop.kind === 'idle' ? (
                <button
                  type="button"
                  className="flex min-h-12 w-full items-center justify-center rounded-xl border border-danger bg-page px-4 text-base font-semibold text-danger disabled:opacity-50"
                  disabled={saving}
                  onClick={() => setStop({ kind: 'confirm' })}
                >
                  เลิกใช้
                </button>
              ) : (
                <div className="space-y-2">
                  <Notice>ยืนยันให้น้องจดดีออกจากกลุ่มนี้ใช่ไหม</Notice>
                  {stopError && <Notice>{stopError}</Notice>}
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center justify-center rounded-xl bg-danger px-4 text-base font-semibold text-white disabled:opacity-50"
                    disabled={stop.kind === 'leaving'}
                    onClick={() => void stopUsing()}
                  >
                    {stop.kind === 'leaving' ? 'กำลังออกจากกลุ่ม...' : 'ยืนยัน เลิกใช้'}
                  </button>
                  <Button variant="ghost" disabled={stop.kind === 'leaving'} onClick={() => { setStopError(null); setStop({ kind: 'idle' }) }}>
                    ยกเลิก
                  </Button>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </Page>
  )
}

/** Static plan mock (decided: no payment code). Styled like Figma UI v4 16A. */
function Plans() {
  return (
    <div className="mt-4 space-y-3">
      <section className="rounded-2xl border-2 border-primary bg-page p-4">
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold">แผน Free</p>
          <Chip tone="done">แพ็กเกจปัจจุบัน</Chip>
        </div>
        <ul className="mt-3 space-y-2 text-sm text-ink-2">
          <li className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-done" />ใช้ได้ทุกฟีเจอร์: สรุปแชต ติดตามและเตือนงาน เก็บไฟล์ สรุปรายสัปดาห์</li>
          <li className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-done" />เก็บไฟล์ใน Google Drive ของเจ้าของบอท</li>
          <li className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-done" />ใช้ AI ได้ตามโควตาการใช้งานที่เหมาะสมต่อเดือน น้องจดดีจะเตือนเมื่อใช้ไป 80%</li>
        </ul>
      </section>
      <section className="rounded-2xl border border-line bg-page p-4">
        <div className="flex items-center justify-between">
          <p className="text-lg font-semibold">แผน Team</p>
          <Chip tone="warn">เร็ว ๆ นี้</Chip>
        </div>
        <ul className="mt-3 space-y-2 text-sm text-ink-2">
          <li className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />โควตา AI มากขึ้นสำหรับทีมที่คุยกันเยอะ</li>
          <li className="flex gap-2"><IconCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />ดูแลหลายโปรเจกต์ในที่เดียว</li>
        </ul>
        <Button variant="outline" className="mt-4" disabled>ยังไม่เปิดให้สมัคร</Button>
      </section>
      <p className="text-center text-xs text-ink-3">หน้านี้เป็นตัวอย่างแพ็กเกจ ยังไม่มีการเก็บเงิน</p>
    </div>
  )
}
