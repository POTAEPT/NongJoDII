'use client'

import { useEffect, useState } from 'react'
import { GoogleView } from './google-view'
import { OwnerView } from './owner-view'
import { ProgressView } from './progress-view'
import { ReviewView } from './review-view'
import { SetupView } from './setup-view'
import { TaskView } from './task-view'
import { initLiff, type LiffViewProps } from './liff-sdk'
import { readLiffParams, type LiffParams } from './params'

const OPEN_FAILED = 'เปิดหน้านี้ไม่สำเร็จ กรุณาลองเปิดจากแชท LINE อีกครั้ง'

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

  if (state.kind === 'error') return <p className="p-4 text-base">{OPEN_FAILED}</p>
  if (state.kind === 'loading') return <p className="p-4 text-base">กำลังเปิด...</p>

  const { params, props } = state
  const viewProps: LiffViewProps = { ...props, id: params.id }
  if (params.view === 'google') return <GoogleView {...viewProps} />
  if (params.view === 'review') return <ReviewView {...viewProps} />
  if (params.view === 'task') return <TaskView {...viewProps} />
  if (params.view === 'progress') return <ProgressView {...viewProps} />
  if (params.view === 'setup') return <SetupView {...viewProps} />
  if (params.view === 'owner') return <OwnerView {...viewProps} />
  return <p className="p-4 text-base">{OPEN_FAILED}</p>
}
