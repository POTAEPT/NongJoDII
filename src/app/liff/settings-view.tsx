'use client'

import { MembersHint } from './members-hint'
import { TAG_SET_MAX } from '@/server/tasks/tags'
import { TagsEditor } from './tags-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NICKNAME_MAX, ROLE_MAX, WEEKDAYS, WORK_DESCRIPTION_MAX } from '@/server/setup/rules'
import { liffUrl } from '@/server/liff-links'
import { formatThaiDateLong } from '@/server/time/bangkok'
import { DELETE_NOW_PHRASE, type SettingsLoad, type StopUsingResult } from '@/server/settings/types'
import { ERR_401, post } from './api'
import type { LiffViewProps } from './liff-sdk'
import { Avatar, Button, Chip, Field, IconCheck, IconLock, IconPlus, Notice, Page, StatusScreen, inputClass } from './ui'
import { formKey, initialSettingsForm, isSettingsDirty, settingsFieldMessage, toMyProfileBody, toSettingsBody, validateMyRow, validateSettings } from './settings-model'
import { FEATURES, TAG_SET_COPY, TIMES_COPY, TimeSelect } from './setup-parts'
import { addNickname, removeNickname, setNickname, setRole, type SetupForm } from './setup-model'

// #28 Settings, opened from the "น้องจดดี ตั้งค่า" card. `id` is groups.id. Two tabs:
// the group's settings (the confirmed Owner edits, everyone else looks) and a static plan
// mock with no payment. The Owner can also Stop using (#11): after a confirm step the bot
// leaves the group, and its data is deleted 7 days later unless the bot is invited back.
// Changing the Owner (#30, #31) comes later. #81: every Member sees everyone's nicknames and
// role, and a Member who is not the Owner edits their own row (saved with /api/me/save).

const ERR_403 = 'คุณไม่ได้อยู่ในกลุ่มนี้'
const ERR_NOT_OWNER = 'เฉพาะเจ้าของบอทของกลุ่มนี้เท่านั้นที่แก้การตั้งค่าได้'
const MEMBER_NOTE = 'เฉพาะเจ้าของบอทที่แก้การตั้งค่ากลุ่มได้ คุณแก้ชื่อเล่นและหน้าที่ของตัวเองได้'
const ERR_404 = 'ไม่พบกลุ่มนี้'
const ERR_400 = 'ข้อมูลไม่ถูกต้อง กรุณาตรวจอีกครั้ง'
const ERR_LOAD = 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'
const ERR_SAVE = 'บันทึกไม่สำเร็จ กรุณาลองใหม่'
// 502: LINE failed, or the bot already left but the leave was not saved yet. Trying again
// finishes it in both cases (LINE then answers 404 and the leave is saved).
const ERR_STOP = 'ยังบันทึกการเลิกใช้ไม่สำเร็จ น้องจดดีอาจออกจากกลุ่มไปแล้ว กรุณากดยืนยันอีกครั้งเพื่อให้เสร็จ'

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
type Stop = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'leaving' } | { kind: 'done'; deleted: boolean; deleteAfter: string | null; wantedDelete: boolean }

/** #147: the delete-now choice and its warnings. */
const DELETE_NOW = {
  label: 'ลบข้อมูลทันที ไม่รอ 7 วัน',
  warn: 'ลบแชตที่เก็บไว้ งาน สรุป และรายชื่อสมาชิกของกลุ่มนี้ทันที กู้คืนไม่ได้ เชิญน้องจดดีกลับมาก็ไม่ได้ข้อมูลเดิม ไฟล์ใน Google Drive ของเจ้าของบอทยังอยู่ ไม่ถูกลบ',
  type: (p: string) => `พิมพ์ “${p}” เพื่อยืนยัน`,
  button: 'ยืนยัน เลิกใช้และลบข้อมูลทันที',
  doneTitle: 'น้องจดดีออกจากกลุ่มและลบข้อมูลแล้ว',
  doneMsg: 'ลบข้อมูลของกลุ่มนี้แล้ว กู้คืนไม่ได้ ไฟล์ใน Google Drive ของเจ้าของบอทยังอยู่',
  failed: 'ลบทันทีไม่สำเร็จ ข้อมูลจะถูกลบตามกำหนดแทน',
}

export function SettingsView({ liff, idToken, liffId, id }: LiffViewProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [form, setForm] = useState<SetupForm | null>(null)
  /** #143: the form as last loaded or saved; Save stays off until something differs. */
  const [baseline, setBaseline] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('settings')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [stop, setStop] = useState<Stop>({ kind: 'idle' })
  const [stopError, setStopError] = useState<string | null>(null)
  const [deleteNow, setDeleteNow] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const started = useRef(false)
  const inFlight = useRef(false)

  const fetchSettings = useCallback(async () => {
    setLoad({ kind: 'loading' })
    if (!id) return setLoad({ kind: 'error', message: ERR_404 })
    try {
      const { status, json } = await post('/api/settings/load', { idToken, groupId: id })
      if (status !== 200) return setLoad({ kind: 'error', message: errorCopy(status, json, ERR_LOAD) })
      const data = json as SettingsLoad
      const initial = initialSettingsForm(data)
      setForm(initial)
      setBaseline(formKey(initial))
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
      if (status === 200) {
        setSaved(true)
        setBaseline(formKey(form))
      } else setError(errorCopy(status, json, ERR_SAVE))
    } catch {
      setError(ERR_SAVE)
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  /** #81: a Member who is not the Owner saves only their own row. */
  const saveMine = async () => {
    if (!form || !load || load.kind !== 'ready' || inFlight.current) return
    const me = load.data.requesterLineUserId
    const problem = validateMyRow(form, me)
    if (problem) return setError(problem)
    const mine = toMyProfileBody(form, me)
    if (!mine) return setError(ERR_403)
    inFlight.current = true
    setError(null)
    setSaving(true)
    try {
      const { status, json } = await post('/api/me/save', { idToken, groupId: id, ...mine })
      if (status === 200) {
        setSaved(true)
        setBaseline(formKey(form))
      } else setError(errorCopy(status, json, ERR_SAVE))
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
      const { status, json } = await post('/api/settings/stop-using', {
        idToken, groupId: id, confirm: true, ...(deleteNow ? { deleteNow: true, confirmText } : {}),
      })
      if (status === 200) {
        const r = json as StopUsingResult
        return setStop({ kind: 'done', deleted: r.deleted === true, deleteAfter: r.deleteAfter, wantedDelete: deleteNow })
      }
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
  if (stop.kind === 'done' && stop.deleted) {
    return <StatusScreen kind="done" appTitle={TITLE} onBack={close} title={DELETE_NOW.doneTitle} message={DELETE_NOW.doneMsg} onClose={close} />
  }
  if (stop.kind === 'done') {
    const date = stop.deleteAfter ? formatThaiDateLong(new Date(stop.deleteAfter)) : null
    return (
      <StatusScreen kind="done" appTitle={TITLE} onBack={close} title="น้องจดดีออกจากกลุ่มแล้ว"
        message={`${stop.wantedDelete ? `${DELETE_NOW.failed} ` : ''}ข้อมูลของกลุ่มนี้จะถูกลบ${date ? `วันที่ ${date}` : 'ใน 7 วัน'} ถ้าเชิญน้องจดดีกลับเข้ากลุ่มก่อนวันนั้น ข้อมูลจะกลับมาครบ ไฟล์ใน Google Drive ของเจ้าของบอทยังอยู่ ไม่ถูกลบ`}
        onClose={close} />
    )
  }
  if (data.state === 'not_set_up' && data.pendingOwner) {
    return <PendingOwnerScreen pendingOwner={data.pendingOwner} groupId={data.groupId} groupName={data.groupName} liffId={liffId} onClose={close} />
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
  const me = data.requesterLineUserId
  // #81: the Owner edits every row; anyone else only their own, shown first.
  const editingMine = tab === 'settings' && !data.canEdit && form.members.some((m) => m.lineUserId === me)
  const dirty = isSettingsDirty(baseline, form)
  const rows = data.canEdit ? form.members : [...form.members].sort((a, b) => Number(b.lineUserId === me) - Number(a.lineUserId === me))

  return (
    <Page
      title={data.groupName ? `${TITLE} · ${data.groupName}` : TITLE}
      onBack={close}
      bottom={editing || editingMine ? (
        <div className="space-y-2">
          {error && <Notice>{error}</Notice>}
          {saved && <Notice tone="success">บันทึกแล้ว</Notice>}
          <Button disabled={saving || !dirty} onClick={() => void (editing ? save() : saveMine())}>
            {saving ? 'กำลังบันทึก...' : editing ? 'บันทึก' : 'บันทึกข้อมูลของฉัน'}
          </Button>
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
          {!data.canEdit && <Notice tone="info">{editingMine ? MEMBER_NOTE : `${ERR_NOT_OWNER} คุณดูได้อย่างเดียว`}</Notice>}

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

          {/* #110 */}
          <div>
            <Field label={TAG_SET_COPY.label}>
              <TagsEditor tags={form.tagSet} max={TAG_SET_MAX} disabled={ro}
                onChange={(tagSet) => set({ ...form, tagSet })} />
            </Field>
            <p className="mt-1 text-xs text-ink-3">{TAG_SET_COPY.hint}</p>
          </div>

          <MemberRows rows={rows} me={me} canEdit={data.canEdit} saving={saving} onChange={set} form={form} />
          <MembersHint known={form.members.length} total={data.lineMemberCount ?? null} />

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
              <TimeSelect value={form.dailyReminderTime} disabled={ro || !form.features.trackRemind} onChange={(v) => set({ ...form, dailyReminderTime: v })} />
            </Field>
            <p className="text-xs text-ink-3">{form.features.trackRemind ? TIMES_COPY.dailyWhat : TIMES_COPY.dailyOff}</p>
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
                    disabled={ro || !form.features.weeklySummary}
                    onClick={() => set({ ...form, weeklySummaryWeekday: d.iso })}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
            <TimeSelect value={form.weeklySummaryTime} disabled={ro || !form.features.weeklySummary} onChange={(v) => set({ ...form, weeklySummaryTime: v })} />
            <p className="text-xs text-ink-3">{form.features.weeklySummary ? TIMES_COPY.weeklyWhat : TIMES_COPY.weeklyOff}</p>
          </section>
          <p className="text-xs text-ink-3">
            เวลาเป็นเวลาประเทศไทย เปลี่ยนแล้วมีผลในรอบถัดไป ถ้าวันนี้เตือนไปแล้ว เวลาใหม่จะเริ่มพรุ่งนี้
          </p>

          {data.canEdit && (
            // #82: the way in to the Google view (change account, disconnect) for the Owner.
            <section className="space-y-3 rounded-2xl border border-line bg-page p-4">
              <span className="block text-sm font-semibold">Google Drive</span>
              <p className="text-xs text-ink-3">
                ดูบัญชี Google ที่เชื่อมอยู่ เปลี่ยนบัญชี หรือยกเลิกการเชื่อมต่อ
              </p>
              <a
                className="flex min-h-12 w-full items-center justify-center rounded-xl border border-line-strong bg-page px-4 text-base font-semibold text-ink"
                href={liffUrl(liffId, 'google')}
              >
                จัดการ Google Drive
              </a>
            </section>
          )}

          {data.canEdit && (
            <section className="space-y-3 rounded-2xl border border-line bg-page p-4">
              <span className="block text-sm font-semibold">เลิกใช้น้องจดดีในกลุ่มนี้</span>
              <p className="text-xs text-ink-3">
                น้องจดดีจะออกจากกลุ่ม และลบข้อมูลของกลุ่มนี้ (แชตที่เก็บไว้ งาน และสรุป) ใน 7 วัน
                ถ้าเชิญกลับภายใน 7 วัน ข้อมูลจะกลับมาครบ ไฟล์ใน Google Drive ไม่ถูกลบ
                ถ้าไม่อยากรอ เลือกลบข้อมูลทันทีได้ในขั้นยืนยัน
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
                  {/* #147: an optional delete at once, behind a typed confirm. */}
                  <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-line p-3 text-sm">
                    <input type="checkbox" className="mt-1" checked={deleteNow} disabled={stop.kind === 'leaving'}
                      onChange={(e) => { setDeleteNow(e.target.checked); setConfirmText('') }} />
                    <span className="font-semibold">{DELETE_NOW.label}</span>
                  </label>
                  {deleteNow && (
                    <div className="space-y-2">
                      <Notice>{DELETE_NOW.warn}</Notice>
                      <Field label={DELETE_NOW.type(DELETE_NOW_PHRASE)}>
                        <input type="text" className={inputClass} value={confirmText} disabled={stop.kind === 'leaving'}
                          autoComplete="off" onChange={(e) => setConfirmText(e.target.value)} />
                      </Field>
                    </div>
                  )}
                  {stopError && <Notice>{stopError}</Notice>}
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center justify-center rounded-xl bg-danger px-4 text-base font-semibold text-white disabled:opacity-50"
                    disabled={stop.kind === 'leaving' || saving || (deleteNow && confirmText.trim() !== DELETE_NOW_PHRASE)}
                    onClick={() => void stopUsing()}
                  >
                    {stop.kind === 'leaving' ? 'กำลังออกจากกลุ่ม...' : deleteNow ? DELETE_NOW.button : 'ยืนยัน เลิกใช้'}
                  </button>
                  <Button variant="ghost" disabled={stop.kind === 'leaving'} onClick={() => { setStopError(null); setDeleteNow(false); setConfirmText(''); setStop({ kind: 'idle' }) }}>
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


/** #81: the "ชื่อเล่นและหน้าที่" list. Everyone sees every row's nicknames and role; the Owner
 *  edits every row, anyone else only their own (marked "คุณ", shown first by the caller). */
export function MemberRows({ rows, me, canEdit, saving, form, onChange }: {
  rows: SetupForm['members']; me: string; canEdit: boolean; saving: boolean
  form: SetupForm; onChange: (next: SetupForm) => void
}) {
  const set = onChange
  const rowEditable = (lineUserId: string) => canEdit || lineUserId === me
  return (
          <section className="space-y-2">
            <span className="block text-sm font-semibold">ชื่อเล่นและหน้าที่</span>
            {rows.map((m) => {
              const editable = rowEditable(m.lineUserId)
              const rowRo = !editable || saving
              return (
              <div key={m.lineUserId} className={`space-y-3 rounded-2xl border bg-page p-4 ${editable && !canEdit ? 'border-primary' : 'border-line'}`}>
                <div className="flex items-center gap-3">
                  <Avatar name={m.displayName} id={m.lineUserId} size="md" />
                  <span className="min-w-0 flex-1 truncate font-semibold">{m.displayName}</span>
                  {m.lineUserId === me && <Chip>คุณ</Chip>}
                  {!editable && m.role && <Chip>{m.role}</Chip>}
                </div>
                {!editable && (
                  // Read-only row (#81): the nicknames as chips; nothing to press.
                  <div className="flex flex-wrap gap-2">
                    {m.nicknames.filter((n) => n.trim() !== '').length > 0
                      ? m.nicknames.filter((n) => n.trim() !== '').map((n, i) => (
                        <span key={i} className="rounded-full border border-line bg-subtle px-3 py-1 text-sm">{n}</span>
                      ))
                      : <span className="text-sm text-ink-3">ยังไม่มีชื่อเล่น</span>}
                  </div>
                )}
                {editable && (
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
                            disabled={rowRo}
                            onChange={(e) => set(setNickname(form, m.lineUserId, i, e.target.value))}
                          />
                          <button
                            type="button"
                            aria-label="ลบชื่อเล่น"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-ink-3"
                            disabled={rowRo}
                            onClick={() => set(removeNickname(form, m.lineUserId, i))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-3 py-1 text-sm font-semibold text-primary"
                        disabled={rowRo}
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
                        disabled={rowRo}
                        onChange={(e) => set(setRole(form, m.lineUserId, e.target.value))}
                      />
                    </Field>
                  </>
                )}
              </div>
              )
            })}
            <p className="text-xs text-ink-3">ชื่อเล่นใช้ให้น้องจดดีอ่านแชตเท่านั้น ทุกหน้าจอแสดงชื่อ LINE</p>
          </section>
  )
}

/** #80: Settings opened while the Owner the setup form named has not confirmed yet (the
 *  setup-done card links Settings in that state too). The nominee is sent to the Owner
 *  confirm page; anyone else is told whom the group waits for. */
export function PendingOwnerScreen({ pendingOwner, groupId, groupName, liffId, onClose }: {
  pendingOwner: NonNullable<SettingsLoad['pendingOwner']>
  groupId: string; groupName: string | null; liffId: string; onClose: () => void
}) {
  const TITLE = 'ตั้งค่า'
  if (!pendingOwner.isRequester) {
    return (
      <StatusScreen kind="forbidden" appTitle={TITLE} onBack={onClose} title={PENDING_OWNER_TEXT.waitTitle}
        message={PENDING_OWNER_TEXT.wait(pendingOwner.displayName)} onClose={onClose} />
    )
  }
  return (
    <Page
      title={TITLE}
      onBack={onClose}
      bottom={
        <a className="flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-base font-semibold text-white"
          href={liffUrl(liffId, 'owner', groupId)}>{PENDING_OWNER_TEXT.confirmButton}</a>
      }
    >
      <div className="flex flex-col items-center pt-6 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconLock className="h-7 w-7" /></span>
        <h2 className="mt-4 text-[22px] font-semibold leading-snug">{PENDING_OWNER_TEXT.youTitle}</h2>
        <p className="mt-2 text-sm text-ink-2">{PENDING_OWNER_TEXT.you(groupName)}</p>
      </div>
    </Page>
  )
}

export const PENDING_OWNER_TEXT = {
  waitTitle: 'รอยืนยันเจ้าของบอท',
  wait: (name: string) => `รอ ${name} ยืนยันเป็นเจ้าของบอทก่อน แล้วค่อยเปิดการตั้งค่าได้`,
  youTitle: 'ยืนยันเป็นเจ้าของบอทก่อน',
  you: (groupName: string | null) => `คุณถูกเลือกเป็นเจ้าของบอทของกลุ่ม ${groupName ?? 'นี้'} ยืนยันก่อน แล้วค่อยเปิดการตั้งค่าได้`,
  confirmButton: 'ยืนยันเป็นเจ้าของบอท',
} as const
