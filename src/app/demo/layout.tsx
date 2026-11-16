import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { demoEnabled } from '@/server/demo/gate'
import './demo.css'

// The /demo LINE simulator (docs/demo-contract.md): 404 unless DEMO_MODE=1, and never on a
// Vercel production deployment.
export const metadata: Metadata = { title: 'น้องจดดี · LINE simulator', robots: { index: false } }

export default function DemoLayout({ children }: LayoutProps<'/demo'>) {
  if (!demoEnabled()) notFound()
  return children
}
