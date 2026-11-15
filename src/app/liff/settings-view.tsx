'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { NICKNAME_MAX, ROLE_MAX, WEEKDAYS, WORK_DESCRIPTION_MAX } from '@/server/setup/rules'
import type { SettingsLoad } from '@/server/settings/types'
import { post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { initialSettingsForm, settingsFieldMessage, toSettingsBody, validateSettings } from './settings-model'
import { FEATURES, TimeSelect } from './setup-parts'
import { addNickname, removeNickname, setNickname, setRole, type SetupForm } from './setup-model'

// #28 Settings, opened from the "NongJoDII ตั้งค่า" card. `id` is groups.id. Two tabs:
// the group's settings (the confirmed Owner edits, everyone else looks) and a static plan
// mock with no payment. Changing the Owner (#30, #31) and Stop using (#11) come later.

const ERR_401 = 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง'
const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้'
const ERR_NOT_OWNER = 'เฉพาะเจ้าของบอทของกลุ่มนี้เท่านั้นที่แก้การตั้งค่าได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SAVE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'

function errorCopy(status: number, json: unknown, fallback: string): string {
  if (status === 401) return ERR_401
  if (status === 403) return (json as { error?: string } | null)?.error === 'not_owner' ? ERR_NOT_OWNER : ERR_403
  if (status === 404) return ERR_404
  if (status === 400) return settingsFieldMessage((json as { field?: unknown } | null)?.field) ?? ERR_400
  return fallback
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: SettingsLoad }
type Tab = 'settings' | 'plans'

export function SettingsView({ liff, idToken, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<SetupForm | null>(null)
  const [tab, setTab] = useState<Tab>('settings')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
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

  if (load.kind === 'loading') return <p className="p-4 text-base">กำลังโหลด...</p>
  if (load.kind === 'error') {
    return (
      <div className="p-4 text-base">
        <p>{load.message}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => void fetchSettings()}>
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
  if (data.state === 'not_set_up') {
    return (
      <div className="p-4 text-base">
        <p>กลุ่มนี้ยังตั้งค่าไม่เสร็จ กรุณาใช้ปุ่ม &quot;ตั้งค่ากลุ่ม&quot; ในการ์ดที่น้องจดดีส่งในกลุ่ม</p>
        {close}
      </div>
    )
  }
  if (!form) return null

  const ro = !data.canEdit || saving
  const set = (next: SetupForm) => {
    setError(null)
    setSaved(false)
    setForm(next)
  }

  return (
    <div className="p-4 text-base">
      <h1 className="text-lg font-bold">ตั้งค่า{data.groupName ? ` · ${data.groupName}` : ''}</h1>
      <div className="mt-3 flex gap-2" role="tablist">
        {(['settings', 'plans'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`flex-1 rounded-full border px-3 py-1 text-sm ${tab === t ? 'bg-blue-700 text-white' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'settings' ? 'ตั้งค่ากลุ่ม' : 'แพ็กเกจ'}
          </button>
        ))}
      </div>

      {tab === 'plans' ? <Plans /> : (
        <div className="mt-4 space-y-4">
          <p className="text-sm">
            เจ้าของบอท: <span className="font-bold">{data.owner?.displayName ?? '-'}</span>
          </p>
          {!data.canEdit && <p className="rounded border p-2 text-sm text-gray-600">{ERR_NOT_OWNER} คุณดูได้อย่างเดียว</p>}

          <section className="space-y-1">
            <span className="text-sm font-bold">กลุ่มนี้ทำเรื่องอะไร</span>
            <textarea
              maxLength={WORK_DESCRIPTION_MAX}
              rows={4}
              className="w-full rounded border p-2"
              value={form.workDescription}
              disabled={ro}
              onChange={(e) => set({ ...form, workDescription: e.target.value })}
            />
          </section>

          <section className="space-y-2">
            <span className="text-sm font-bold">{data.canEdit ? 'ชื่อเล่นและหน้าที่' : 'สมาชิก'}</span>
            {form.members.map((m) => (
              <div key={m.lineUserId} className="space-y-2 rounded border p-3">
                <span className="font-bold">{m.displayName}</span>
                {data.canEdit && (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {m.nicknames.map((n, i) => (
                        <span key={i} className="flex items-center rounded-full border px-2">
                          <input
                            type="text"
                            aria-label="ชื่อเล่น"
                            maxLength={NICKNAME_MAX}
                            className="w-24 bg-transparent p-1 text-sm"
                            value={n}
                            disabled={ro}
                            onChange={(e) => set(setNickname(form, m.lineUserId, i, e.target.value))}
                          />
                          <button
                            type="button"
                            aria-label="ลบชื่อเล่น"
                            className="px-1 text-gray-500"
                            disabled={ro}
                            onClick={() => set(removeNickname(form, m.lineUserId, i))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="rounded-full border border-dashed px-3 py-1 text-sm text-blue-700"
                        disabled={ro}
                        onClick={() => set(addNickname(form, m.lineUserId))}
                      >
                        + ชื่อเล่น
                      </button>
                    </div>
                    <label className="block">
                      <span className="text-sm">หน้าที่</span>
                      <input
                        type="text"
                        maxLength={ROLE_MAX}
                        className="mt-1 w-full rounded border p-2"
                        value={m.role}
                        disabled={ro}
                        onChange={(e) => set(setRole(form, m.lineUserId, e.target.value))}
                      />
                    </label>
                  </>
                )}
              </div>
            ))}
            <p className="text-xs text-gray-500">ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE</p>
          </section>

          <section className="space-y-2">
            <span className="text-sm font-bold">ฟีเจอร์</span>
            {FEATURES.map((f) => (
              <label key={f.key} className="flex items-start gap-3 rounded border p-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.features[f.key]}
                  disabled={ro}
                  onChange={(e) => set({ ...form, features: { ...form.features, [f.key]: e.target.checked } })}
                />
                <span>
                  <span className="block font-bold">{f.label}</span>
                  <span className="block text-sm text-gray-600">{f.sub}</span>
                </span>
              </label>
            ))}
          </section>

          <section className="rounded border p-3">
            <span className="text-sm font-bold">เตือนงานทุกวัน</span>
            <TimeSelect value={form.dailyReminderTime} disabled={ro} onChange={(v) => set({ ...form, dailyReminderTime: v })} />
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
                  disabled={ro}
                  onClick={() => set({ ...form, weeklySummaryWeekday: d.iso })}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <TimeSelect value={form.weeklySummaryTime} disabled={ro} onChange={(v) => set({ ...form, weeklySummaryTime: v })} />
          </section>
          <p className="text-xs text-gray-500">
            เวลาเป็นเวลาประเทศไทย เปลี่ยนแล้วมีผลในรอบถัดไป ถ้าวันนี้เตือนไปแล้ว เวลาใหม่จะเริ่มพรุ่งนี้
          </p>

          {data.canEdit && (
            <div className="space-y-2">
              {error && <p role="alert">{error}</p>}
              {saved && <p className="font-bold">บันทึกแล้ว ✓</p>}
              <button
                type="button"
                className="w-full rounded border px-4 py-2 font-bold"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'กำลังบันทึก...' : 'บันทึก'}
              </button>
            </div>
          )}
          {close}
        </div>
      )}
    </div>
  )
}

/** Static plan mock (decided: no payment code). */
function Plans() {
  return (
    <div className="mt-4 space-y-3">
      <section className="rounded border-2 border-blue-700 p-3">
        <p className="font-bold">Free <span className="text-sm font-normal text-blue-700">· แพ็กเกจปัจจุบัน</span></p>
        <ul className="mt-2 list-disc pl-5 text-sm">
          <li>ใช้ได้ทุกฟีเจอร์: สรุปแชต ติดตามและเตือนงาน เก็บไฟล์ สรุปรายสัปดาห์</li>
          <li>เก็บไฟล์ใน Google Drive ของเจ้าของบอท</li>
          <li>ใช้ AI ได้ตามโควตาการใช้งานที่เหมาะสมต่อเดือน น้องจดดีจะเตือนเมื่อใช้ไป 80%</li>
        </ul>
      </section>
      <section className="rounded border p-3">
        <p className="font-bold">Team <span className="text-sm font-normal text-gray-500">· เร็ว ๆ นี้</span></p>
        <ul className="mt-2 list-disc pl-5 text-sm">
          <li>โควตา AI มากขึ้นสำหรับทีมที่คุยกันเยอะ</li>
          <li>ดูแลหลายโปรเจกต์ในที่เดียว</li>
        </ul>
        <button type="button" className="mt-3 w-full rounded border px-4 py-2 text-gray-500" disabled>
          ยังไม่เปิดให้สมัคร
        </button>
      </section>
      <p className="text-xs text-gray-500">หน้านี้เป็นตัวอย่างแพ็กเกจ ยังไม่มีการเก็บเงิน</p>
    </div>
  )
}
