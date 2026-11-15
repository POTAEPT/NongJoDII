'use client'

import { useEffect, useState } from 'react'
import { GoogleView } from './google-view'
import { MeView } from './me-view'
import { OwnerView } from './owner-view'
import { ProgressView } from './progress-view'
import { ReviewView } from './review-view'
import { SettingsView } from './settings-view'
import { SetupView } from './setup-view'
import { TaskView } from './task-view'
import { initLiff, type LiffViewProps } from './liff-sdk'
import { readLiffParams, type LiffParams } from './params'
import { StatusScreen } from './ui'

const OPEN_FAILED = 'กรุณาลองเปิดจากแชต LINE อีกครั้ง'

type State =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; params: LiffParams; props: Omit<LiffViewProps, 'id'> }

export function LiffApp({ liffId }: { liffId: string }) {
  const [state, setState] = useState<State>(liffId ? { kind: 'loading' } : { kind: 'error' })

  useEffect(() => {
    if (!liffId) return
    let cancelled = false
    initLiff(liffId)
      .then((result) => {
        if (cancelled || 'redirecting' in result) return
        setState({
          kind: 'ready',
          params: readLiffParams(window.location.search),
          props: { liff: result.liff, idToken: result.idToken, liffId },
        })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [liffId])

  if (state.kind === 'error') return <StatusScreen kind="error" title="เปิดหน้านี้ไม่สำเร็จ" message={OPEN_FAILED} />
  if (state.kind === 'loading') return <StatusScreen kind="loading" message="กำลังเปิด..." />

  const { params, props } = state
  const viewProps: LiffViewProps = { ...props, id: params.id }
  if (params.view === 'google') return <GoogleView {...viewProps} />
  if (params.view === 'review') return <ReviewView {...viewProps} />
  if (params.view === 'task') return <TaskView {...viewProps} />
  if (params.view === 'progress') return <ProgressView {...viewProps} />
  if (params.view === 'setup') return <SetupView {...viewProps} />
  if (params.view === 'owner') return <OwnerView {...viewProps} />
  if (params.view === 'me') return <MeView {...viewProps} />
  if (params.view === 'settings') return <SettingsView {...viewProps} />
  return <StatusScreen kind="error" title="เปิดหน้านี้ไม่สำเร็จ" message={OPEN_FAILED} />
}
