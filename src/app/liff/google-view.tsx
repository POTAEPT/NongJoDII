'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchGoogleStatus as fetchStatus, phaseOnOpen, phaseOnReturn, returnVisit } from './google-status'
import type { LiffViewProps } from './liff-sdk'

type Phase =
  | 'checking' | 'starting' | 'opened' | 'connected' | 'sign_in_again' | 'change_unfinished'
  | 'not_connected' | 'unauthorized' | 'failed'

const COPY: Record<Exclude<Phase, 'starting' | 'checking' | 'connected' | 'sign_in_again' | 'change_unfinished'>, string> = {
  opened: 'เปิดเบราว์เซอร์เพื่อเข้าสู่ระบบ Google แล้ว เมื่อเสร็จให้กลับมาที่แชท LINE',
  not_connected: 'ยังไม่ได้เชื่อม Google Drive กรุณาลองใหม่',
  unauthorized: 'ยืนยันตัวตน LINE ไม่สำเร็จ กรุณาเปิดจากแชทอีกครั้ง',
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

  // Callers set 'starting' first. `change` asks Google for its account chooser (#14).
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
      // Any other non-200 (e.g. a bare 500 when LINE verify fails upstream) is a retryable failure.
      if (res.status !== 200) return setPhase('failed')
      const { url } = (await res.json()) as { url?: unknown }
      if (typeof url !== 'string' || !url) return setPhase('failed')
      if (liff.isInClient()) {
        // Google refuses OAuth inside LINE's in-app webview (403 disallowed_useragent),
        // so sign-in runs in the external browser; its callback page links back here.
        liff.openWindow({ url, external: true })
        setPhase('opened')
      } else {
        window.location.href = url
      }
    } catch {
      setPhase('failed')
    }
  }, [liff, idToken])

  // First load: read the status. A person with no Google account goes straight to
  // sign-in (not on a return visit from the callback page). A connected one sees the connected screen,
  // and a revoked or expired one the sign-in-again notice (#14); neither starts a sign-in
  // by itself.
  const init = useCallback(async () => {
    const status = await fetchStatus(idToken)
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

  // While the external browser is open, re-check only when the user comes back to
  // LINE (visibility or focus). No timer polling.
  useEffect(() => {
    if (phase !== 'opened') return
    let inFlight = false
    const recheck = async () => {
      if (inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const status = await fetchStatus(idToken)
        const next = phaseOnReturn(status, knownSignedInAt.current)
        if (!next) return
        if (next === 'connected') {
          knownSignedInAt.current = status.signedInAt
          setCanChange(status.canChange)
          setJustSignedIn(true)
        }
        setPhase(next)
      } finally {
        inFlight = false
      }
    }
    const onEvent = () => void recheck()
    document.addEventListener('visibilitychange', onEvent)
    window.addEventListener('focus', onEvent)
    return () => {
      document.removeEventListener('visibilitychange', onEvent)
      window.removeEventListener('focus', onEvent)
    }
  }, [phase, idToken])

  if (phase === 'starting') return <p className="p-4 text-base">กำลังเตรียมเชื่อม Google Drive...</p>
  if (phase === 'checking') return <p className="p-4 text-base">กำลังตรวจสอบการเชื่อม Google Drive...</p>
  if (phase === 'connected') {
    return (
      <div className="p-4 text-base">
        <p className="text-lg font-bold">{justSignedIn ? 'เชื่อม Google Drive สำเร็จ' : 'เชื่อม Google Drive ไว้แล้ว'}</p>
        <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => liff.closeWindow()}>
          ปิดหน้านี้
        </button>
        {canChange && (
          <div className="mt-8 border-t pt-4">
            <p className="text-sm text-gray-600">
              เปลี่ยนไปใช้บัญชี Google อื่นได้ ไฟล์ที่เก็บไว้แล้วจะอยู่ในไดรฟ์เดิม ส่วนไฟล์ใหม่จะเก็บในโฟลเดอร์ใหม่ในไดรฟ์ของบัญชีใหม่
            </p>
            <button type="button" className="mt-2 rounded border px-4 py-2" onClick={() => signIn(true)}>
              เปลี่ยนบัญชี Google
            </button>
          </div>
        )}
      </div>
    )
  }
  if (phase === 'change_unfinished') {
    // The new account is stored, but a Project is still connected to the old one: the
    // same sign-in again finishes the change.
    return (
      <div className="p-4 text-base">
        <p className="text-lg font-bold">เปลี่ยนบัญชี Google ยังไม่เสร็จ</p>
        <p className="mt-2">กรุณาเข้าสู่ระบบด้วยบัญชี Google ที่ต้องการใช้อีกครั้ง งานและไฟล์ที่เก็บไว้แล้วยังอยู่ครบ</p>
        <button type="button" className="mt-4 rounded border px-4 py-2 font-bold" onClick={() => signIn(true)}>
          เปลี่ยนบัญชี Google
        </button>
      </div>
    )
  }
  if (phase === 'sign_in_again') {
    return (
      <div className="p-4 text-base">
        <p className="text-lg font-bold">กรุณาเข้าสู่ระบบ Google อีกครั้ง</p>
        <p className="mt-2">
          น้องจดดีเข้าถึง Google Drive ของคุณไม่ได้แล้ว จึงยังเก็บไฟล์ใหม่ไม่ได้ งานทั้งหมดยังอยู่ครบ
        </p>
        <button type="button" className="mt-4 rounded border px-4 py-2 font-bold" onClick={() => signIn(false)}>
          เข้าสู่ระบบ Google
        </button>
      </div>
    )
  }
  return (
    <div className="p-4 text-base">
      <p>{COPY[phase]}</p>
      <button type="button" className="mt-4 rounded border px-4 py-2" onClick={() => signIn(changing.current)}>
        ลองอีกครั้ง
      </button>
    </div>
  )
}
