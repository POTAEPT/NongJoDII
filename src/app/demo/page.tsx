import { notFound } from 'next/navigation'
import { demoEnabled } from '@/server/demo/gate'
import { DemoApp } from './_components/demo-app'

export default function DemoPage() {
  if (!demoEnabled()) notFound()
  return <DemoApp />
}
