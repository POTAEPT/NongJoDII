'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGoogleStatus as fetchStatus, type GoogleFailure, phaseOnOpen, retryStep, returnStep, returnVisit } from './google-status'
import type { LiffViewProps } from './liff-sdk'
import { Button, IconCheck, IconCloud, IconLock, Notice, Page, StatusScreen } from './ui'

// Connect Google Drive (#3, #14), styled like Figma UI v4 #11.
const TITLE = 'เชื่อม Google Drive'

type Phase =
  | 'checking' | 'starting' | 'opened' | 'connected' | 'sign_in_again' | 'change_unfinished'
  | 'not_connected' | 'unauthorized' | 'failed'

const COPY: Record<Exclude<Phase, 'starting' | 'checking' | 'connected' | 'sign_in_again' | 'change_unfinished'>, string> = {
  opened: 'เปิดเบราว์เซอร์เพื่อเข้าสู่ระบบ Google แล้ว เมื่อเสร็จให้กลับมาที่แชต LINE',
  not_connected: 'ยังไม่ได้เชื่อม Google Drive กรุณาลองใหม่',
  unauthorized: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชตอีกครั้ง',
  failed: 'เริ่มเชื่อม Google Drive ไม่สำเร็จ กรุณาลองใหม่',
}

export function GoogleView({ liff, idToken, id }: LiffViewProps) {
  // The OAuth callback page links back with an id: the sign-in already ran in the external
  // browser, so only the status is checked, and only a finished one is greeted as a success.
  const { returning, signedIn } = returnVisit(id)
  const [phase, setPhase] = useState<Phase>('checking')
  /** A sign-in finished in this visit, or just before it (the return visit after 'ok'). */
  const [justSignedIn, setJustSignedIn] = useState(signedIn)
  /** #14: the confirmed Owner of a Project may change the connected Google account. */
  const [canChange, setCanChange] = useState(false)
  const started = useRef(false)
  /** The sign-in time the server reported last. A sign-in started from here is done only
   *  when the server reports a newer one: during a change of account the old account is
   *  still connected. */
  const knownSignedInAt = useRef<string | null>(null)
  /** Whether the sign-in in progress is a change of account, so a retry asks the same. */
  const changing = useRef(false)
  /** The status request has answered with the person's state (not failed or refused). */
  const statusKnown = useRef(false)
  /** What failed last, so the retry repeats that step and not another (see retryStep). */
  const lastFailure = useRef<GoogleFailure>('start')
  /** A sign-in opened in the external browser during this visit. */
  const signInOpened = useRef(false)
  const recheckInFlight = useRef(false)

  // Callers set 'starting' first. `change` is the "change Google account" action (#14):
  // the server seals it into the sign-in, and only such a sign-in moves a Project.
  const start = useCallback(async (change: boolean) => {
    changing.current = change
    try {
      // Only the ID token (and the change flag) go up: the server takes the user from the
      // verified token and checks the Owner role itself.
      const res = await fetch('/api/google/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change ? { idToken, change: true } : { idToken }),
      })
      if (res.status === 401) return setPhase('unauthorized')
      lastFailure.current = 'start'
      // Any other non-200 (e.g. a bare 500 when LINE verify fails upstream) is a retryable failure.
      if (res.status !== 200) return setPhase('failed')
      const { url } = (await res.json()) as { url?: unknown }
      if (typeof url !== 'string' || !url) return setPhase('failed')
      if (liff.isInClient()) {
        // Google refuses OAuth inside LINE's in-app webview (403 disallowed_useragent),
        // so sign-in runs in the external browser; its callback page links back here.
        liff.openWindow({ url, external: true })
        signInOpened.current = true
        setPhase('opened')
      } else {
        window.location.href = url
      }
    } catch {
      lastFailure.current = 'start'
      setPhase('failed')
    }
  }, [liff, idToken])

  // First load: read the status. A person with no Google account goes straight to
  // sign-in (not on a return visit from the callback page). A connected one sees the connected screen,
  // and a revoked or expired one the sign-in-again notice (#14); neither starts a sign-in
  // by itself.
  const init = useCallback(async () => {
    const status = await fetchStatus(idToken)
    statusKnown.current = status.status !== 'failed' && status.status !== 'unauthorized'
    if (status.status === 'failed') lastFailure.current = 'status'
    knownSignedInAt.current = status.signedInAt
    setCanChange(status.canChange)
    const next = phaseOnOpen(status, returning)
    if (next !== 'start') return setPhase(next)
    setPhase('starting')
    return start(false)
  }, [returning, idToken, start])

  useEffect(() => {
    if (started.current) return // StrictMode double mount must not start sign-in twice
    started.current = true
    void init()
  }, [init])

  const signIn = (change: boolean) => {
    setPhase('starting')
    void start(change)
  }

  // One look at the status after a sign-in opened: on return to LINE, or from the retry.
  const recheck = useCallback(async () => {
    if (recheckInFlight.current || document.visibilityState !== 'visible') return
    recheckInFlight.current = true
    try {
      const status = await fetchStatus(idToken)
      const step = returnStep(status, knownSignedInAt.current)
      knownSignedInAt.current = step.knownSignedInAt
      if (!step.phase) return
      if (step.phase === 'failed') lastFailure.current = 'status'
      if (step.phase === 'connected') {
        setCanChange(status.canChange)
        setJustSignedIn(true)
      }
      setPhase(step.phase)
    } finally {
      recheckInFlight.current = false
    }
  }, [idToken])

  // The retry button repeats what failed (see retryStep).
  const retry = () => {
    const step = retryStep({ statusKnown: statusKnown.current, lastFailure: lastFailure.current, signInOpened: signInOpened.current })
    if (step === 'start') return signIn(changing.current)
    if (step === 'recheck') {
      setPhase('opened')
      return void recheck()
    }
    setPhase('checking')
    void init()
  }

  // While the external browser is open, re-check only when the user comes back to
  // LINE (visibility or focus). No timer polling.
  useEffect(() => {
    if (phase !== 'opened') return
    const onEvent = () => void recheck()
    document.addEventListener('visibilitychange', onEvent)
    window.addEventListener('focus', onEvent)
    return () => {
      document.removeEventListener('visibilitychange', onEvent)
      window.removeEventListener('focus', onEvent)
    }
  }, [phase, recheck])

  const close = () => liff.closeWindow()
  if (phase === 'starting') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังเตรียมเชื่อม Google Drive..." />
  if (phase === 'checking') return <StatusScreen kind="loading" appTitle={TITLE} message="กำลังตรวจสอบการเชื่อม Google Drive..." />
  if (phase === 'connected') {
    return (
      <Page title={TITLE} onBack={close} bottom={<Button onClick={close}>ปิดหน้านี้</Button>}>
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-done-bg text-done"><IconCheck className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">{justSignedIn ? 'เชื่อม Google Drive สำเร็จ' : 'เชื่อม Google Drive ไว้แล้ว'}</h2>
          <p className="mt-2 text-sm text-ink-2">ไฟล์ใหม่ในกลุ่มจะถูกเก็บในโฟลเดอร์ NongJoDII ใน Drive ของคุณ</p>
        </div>
        {canChange && (
          <section className="mt-8 space-y-3 rounded-2xl border border-line bg-page p-4">
            <p className="text-sm text-ink-2">
              เปลี่ยนไปใช้บัญชี Google อื่นได้ ไฟล์ที่เก็บไว้แล้วจะอยู่ในไดรฟ์เดิม ส่วนไฟล์ใหม่จะเก็บในโฟลเดอร์ใหม่ในไดรฟ์ของบัญชีใหม่
            </p>
            <Button variant="outline" onClick={() => signIn(true)}>เปลี่ยนบัญชี Google</Button>
          </section>
        )}
      </Page>
    )
  }
  if (phase === 'change_unfinished') {
    // The person's latest Google sign-in is another account than the one a Project of
    // theirs is connected to: a plain sign-in with another account (which changes
    // nothing), or a change that stopped part-way. Either the change action moves the
    // Project, or a sign-in with the first account puts things back.
    return (
      <Page title={TITLE} onBack={close} bottom={
        <div className="space-y-2">
          <Button onClick={() => signIn(true)}>เปลี่ยนบัญชี Google</Button>
          <Button variant="outline" onClick={() => signIn(false)}>เข้าสู่ระบบด้วยบัญชีเดิม</Button>
        </div>
      }>
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-warn-bg text-warn"><IconCloud className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">บัญชี Google นี้ยังไม่ได้เชื่อมกับกลุ่ม</h2>
          <p className="mt-2 text-sm text-ink-2">
            กลุ่มของคุณยังเชื่อมกับบัญชี Google อีกบัญชีหนึ่งอยู่ น้องจดดีจึงยังเก็บไฟล์ใหม่ไม่ได้ งานและไฟล์ที่เก็บไว้แล้วยังอยู่ครบ
          </p>
        </div>
        <div className="mt-6">
          <Notice tone="info">
            หากต้องการย้ายมาใช้บัญชีใหม่ ให้กดเปลี่ยนบัญชี Google ไฟล์ที่เก็บไว้แล้วจะอยู่ในไดรฟ์เดิม หากไม่ต้องการเปลี่ยน ให้เข้าสู่ระบบด้วยบัญชีเดิม
          </Notice>
        </div>
      </Page>
    )
  }
  if (phase === 'sign_in_again') {
    return (
      <Page title={TITLE} onBack={close} bottom={<Button onClick={() => signIn(false)}>เข้าสู่ระบบ Google</Button>}>
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-warn-bg text-warn"><IconLock className="h-7 w-7" /></span>
          <h2 className="mt-4 text-xl font-semibold">กรุณาเข้าสู่ระบบ Google อีกครั้ง</h2>
          <p className="mt-2 text-sm text-ink-2">
            น้องจดดีเข้าถึง Google Drive ของคุณไม่ได้แล้ว จึงยังเก็บไฟล์ใหม่ไม่ได้ งานทั้งหมดยังอยู่ครบ
          </p>
        </div>
      </Page>
    )
  }
  if (phase === 'opened') {
    return (
      <Page title={TITLE} onBack={close} bottom={<Button variant="outline" onClick={retry}>ลองอีกครั้ง</Button>}>
        <div className="flex flex-col items-center pt-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-soft text-primary"><IconCloud className="h-7 w-7" /></span>
          <h2 className="mt-4 text-lg font-semibold">เข้าสู่ระบบ Google ในเบราว์เซอร์</h2>
          <p className="mt-2 text-sm text-ink-2">{COPY.opened}</p>
        </div>
        <p className="mt-6 flex items-start gap-2 rounded-xl bg-primary-soft px-3 py-3 text-sm text-primary">
          <IconLock className="mt-0.5 h-4 w-4 shrink-0" />
          ขอสิทธิ์เฉพาะไฟล์ที่น้องจดดีสร้าง (drive.file) ไม่เห็นไฟล์อื่นใน Drive ของคุณ
        </p>
      </Page>
    )
  }
  return (
    <StatusScreen kind="error" appTitle={TITLE} onBack={close} title="เชื่อม Google Drive ไม่สำเร็จ" message={COPY[phase]}
      onRetry={retry} onClose={close} />
  )
}
