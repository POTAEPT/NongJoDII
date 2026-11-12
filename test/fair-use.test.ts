import { describe, expect, it } from 'vitest'
import { capMessage, getFairUseStatus, warnMessage } from '@/server/usage/fair-use'
import { makeTestDeps } from './harness'

const NOW = new Date('2026-11-12T03:00:00Z')
const OWNER = 'Uowner1'

function setup() {
  const t = makeTestDeps({ now: NOW })
  const a = t.store.seedGroup({ lineGroupId: 'Ca' })
  const b = t.store.seedGroup({ lineGroupId: 'Cb' })
  return { ...t, a, b }
}

describe('getFairUseStatus', () => {
  it('no usage is under, fraction 0, resets on the 1st of next month 00:00 Bangkok', async () => {
    const t = setup()
    const s = await getFairUseStatus(t.store, OWNER, NOW)
    expect(s).toMatchObject({ level: 'under', fraction: 0, tokens: 0, costMicroUsd: 0, monthStartBkk: '2026-11-01' })
    expect(s.resetAt.toISOString()).toBe('2026-11-30T17:00:00.000Z')
  })

  it('$0.39 is under; $0.40 as four $0.10 rows is warn (integer micro-dollar compare); 4.8M tokens is warn', async () => {
    const t = setup()
    t.store.seedAiUsage({ costUsd: 0.39, createdAt: NOW })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('under')
    const u = setup()
    for (let i = 0; i < 4; i++) u.store.seedAiUsage({ costUsd: 0.1, createdAt: NOW })
    const w = await getFairUseStatus(u.store, OWNER, NOW)
    expect(w.costMicroUsd).toBe(400_000)
    expect(w.level).toBe('warn')
    const v = setup()
    v.store.seedAiUsage({ inputTokens: 4_000_000, outputTokens: 800_000, createdAt: NOW })
    expect((await getFairUseStatus(v.store, OWNER, NOW)).level).toBe('warn')
  })

  it('$0.50 as five $0.10 rows is capped; 6M tokens with $0.01 is capped; $0.55 is capped', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) t.store.seedAiUsage({ costUsd: 0.1, createdAt: NOW })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('capped')
    const u = setup()
    u.store.seedAiUsage({ inputTokens: 6_000_000, costUsd: 0.01, createdAt: NOW })
    expect((await getFairUseStatus(u.store, OWNER, NOW)).level).toBe('capped')
    const v = setup()
    v.store.seedAiUsage({ costUsd: 0.55, createdAt: NOW })
    expect((await getFairUseStatus(v.store, OWNER, NOW)).level).toBe('capped')
  })

  it('tokens cap holds when cost is reported as $0', async () => {
    const t = setup()
    t.store.seedAiUsage({ inputTokens: 5_000_000, outputTokens: 1_000_000, costUsd: 0, createdAt: NOW })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('capped')
  })

  it('excludes another Owner', async () => {
    const t = setup()
    t.store.seedAiUsage({ ownerLineUserId: 'Uother', costUsd: 0.6, createdAt: NOW })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('under')
  })

  it('sums the same Owner across two groups', async () => {
    const t = setup()
    t.store.seedAiUsage({ groupId: t.a.id, costUsd: 0.3, createdAt: NOW })
    t.store.seedAiUsage({ groupId: t.b.id, costUsd: 0.21, createdAt: NOW })
    const s = await getFairUseStatus(t.store, OWNER, NOW)
    expect(s.costMicroUsd).toBe(510_000)
    expect(s.level).toBe('capped')
  })

  it('excludes October usage in November', async () => {
    const t = setup()
    t.store.seedAiUsage({ costUsd: 0.9, createdAt: new Date('2026-10-31T16:59:00Z') })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('under')
  })

  it('a row at 2026-11-30T17:00:00Z counts in December, not November', async () => {
    const t = setup()
    t.store.seedAiUsage({ costUsd: 0.5, createdAt: new Date('2026-11-30T17:00:00Z') })
    expect((await getFairUseStatus(t.store, OWNER, NOW)).level).toBe('under')
    const dec = await getFairUseStatus(t.store, OWNER, new Date('2026-12-05T00:00:00Z'))
    expect(dec.level).toBe('capped')
    expect(dec.monthStartBkk).toBe('2026-12-01')
  })
})

describe('messages', () => {
  it('capMessage carries the reset date and the token cap', () => {
    const m = capMessage({
      tokens: 6_100_000, costMicroUsd: 200_000, fraction: 1.02, level: 'capped',
      resetAt: new Date('2026-11-30T17:00:00Z'), monthStartBkk: '2026-11-01',
    })
    if (m.type !== 'text') throw new Error('not text')
    expect(m.text).toContain('1 ธันวาคม 2569 เวลา 00:00 น.')
    expect(m.text).toContain('6,000,000')
    expect(m.text).toContain('6,100,000 / 6,000,000 โทเคน และ $0.2000 / $0.50')
  })

  it('warnMessage floors the percent', () => {
    const m = warnMessage({
      tokens: 100, costMicroUsd: 410_000, fraction: 0.82, level: 'warn',
      resetAt: new Date('2026-11-30T17:00:00Z'), monthStartBkk: '2026-11-01',
    })
    if (m.type !== 'text') throw new Error('not text')
    expect(m.text).toContain('แจ้งเตือน: ใช้ AI ไปแล้ว 82% ของโควตาฟรีเดือนนี้')
    expect(m.text).toContain('โควตาจะเริ่มใหม่วันที่ 1 ธันวาคม 2569 เวลา 00:00 น.')
  })
})
