import type { Metadata } from 'next'
import { LiffApp } from './liff-app'

export const metadata: Metadata = { title: 'น้องจดดี' } // IDs only in titles: Clarity reads them

export default function LiffPage() {
  return <LiffApp liffId={process.env.NEXT_PUBLIC_LIFF_ID ?? ''} />
}
