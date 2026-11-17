import { describe, expect, it } from 'vitest'
import { DemoLlm } from '@/server/demo/demo-llm'
import { resetDemo, type Demo } from '@/server/demo/demo-deps'
import { nextWeeklyFire, runSimAction, simState } from '@/server/demo/sim'
import type { ChatItem } from '@/server/demo/types'

// The bot's 1:1 chat in /demo: the Owner's weekly card (#120) through POST weekly, and the
// Rich Menu (#84) through 1:1 messages on the real webhook.

/** Wednesday 2026-11-18 10:20 Bangkok: the seeded weekly slot of the first Project is then
 *  Wednesday 11:00, the second Project's Thursday 11:00. */
const WED_1020 = Date.parse('2026-11-18T03:20:00Z')

function fresh(at = WED_1020): Demo {
  return resetDemo({ setup: true, llm: new DemoLlm({ inner: null }), offsetMs: at - Date.now() })
}

async function sim(action: string, body: unknown = {}) {
  const res = await runSimAction(action, 'POST', body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Record<string, unknown>
}

const json = (c: ChatItem | undefined) => JSON.stringify(c?.message ?? null)
const groupLens = (demo: Demo) => demo.world.groups.map((g) => g.chat.length)

/** Quota a tick's group pushes cost: each new pushed item times its group's members. */
function groupPushCost(demo: Demo, lensBefore: number[]): number {
  return demo.world.groups.reduce((n, g, i) => {
    const pushes = g.chat.slice(lensBefore[i]).filter((c) => c.from === 'bot' && c.via === 'push').length
    return n + pushes * demo.world.membersInGroup(g).length
  }, 0)
}

describe('/demo sim/weekly: the Owner card in the 1:1 chat', () => {
  it('moves the clock to the main group slot and pushes one per-person card to Nont, costing 1', async () => {
    const demo = fresh()
    const quota = demo.world.quota.used
    const lens = groupLens(demo)
    const res = await sim('weekly')
    await demo.idle()
    expect(res).toMatchObject({ owner: 'nont', ownerCards: 1, group: 'Cdemo0000000000000000000000000001' })
    expect(demo.world.now().toISOString().slice(0, 16)).toBe('2026-11-18T04:00')

    const direct = simState(demo).direct.nont
    expect(direct).toHaveLength(1)
    const card = json(direct[0])
    expect(card).toContain('สรุปรายคนสัปดาห์นี้')
    expect(card).toContain('ทีมพิตช์ NongJoDII')
    // Seeded so every count shows: in process, done this week, overdue, stale.
    expect(card).toContain('กำลังทำ')
    expect(card).toContain('เสร็จ 1')
    expect(card).toContain('เลยกำหนด 1')
    expect(card).toContain('ไม่อัปเดตเกิน 5 วัน 1')
    expect(card).toContain('https://liff.line.me/demo-liff?view=dashboard')
    // The 1:1 push costs 1; the rest of the rise is the group weekly cards (#21).
    expect(demo.world.quota.used - quota - groupPushCost(demo, lens)).toBe(1)
    expect(demo.world.log.some((l) => l.kind === 'push' && l.summary.startsWith('1:1 push to Nont') && l.summary.includes('cost 1'))).toBe(true)
    // The other Project's slot is a day later: no second card yet.
    expect(demo.world.log.filter((l) => l.summary.startsWith('1:1 push'))).toHaveLength(1)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
    // Unread until the thread is opened.
    expect(simState(demo).directChats.find((d) => d.persona === 'nont')).toMatchObject({ unread: 1 })
    await sim('open-direct', { persona: 'nont' })
    expect(simState(demo)).toMatchObject({ openDirect: 'nont' })
    expect(simState(demo).directChats.find((d) => d.persona === 'nont')?.unread).toBe(0)
  })

  it('a second call gives the next week card', async () => {
    const demo = fresh()
    await sim('weekly')
    const quota = demo.world.quota.used
    const lens = groupLens(demo)
    const res = await sim('weekly')
    await demo.idle()
    expect(res).toMatchObject({ owner: 'nont', ownerCards: 1 })
    expect(demo.world.now().toISOString().slice(0, 16)).toBe('2026-11-25T04:00')
    const direct = simState(demo).direct.nont
    expect(direct.filter((c) => json(c).includes('สรุปรายคนสัปดาห์นี้'))).toHaveLength(2)
    expect(json(direct[1])).toContain('ทีมพิตช์ NongJoDII')
    expect(demo.store.tables.webhook_events.some((e) => e.webhookEventId.startsWith('owner_insight:') && e.webhookEventId.endsWith(':2026-11-23'))).toBe(true)
    // The second Project's Thursday slot passed in between but no tick ran then; this tick
    // (Wednesday) is not its weekday. So again exactly one 1:1 push.
    expect(demo.world.quota.used - quota - groupPushCost(demo, lens)).toBe(1)
  })

  it('with the second Project selected, reaches its own slot', async () => {
    const demo = fresh()
    const cafe = demo.world.groups.find((g) => g.name === 'ลูกค้า ร้านกาแฟ')!.lineGroupId
    await sim('select-group', { group: cafe })
    const res = await sim('weekly')
    expect(res).toMatchObject({ owner: 'nont', ownerCards: 1, group: cafe })
    expect(demo.world.now().toISOString().slice(0, 16)).toBe('2026-11-19T04:00')
    expect(json(simState(demo).direct.nont.at(-1))).toContain('ลูกค้า ร้านกาแฟ')
  })

  it('nextWeeklyFire: now when the slot is reached today, else the next slot whose week has not run', () => {
    const slot = { weekday: 3, time: '11:00:00', lastSentOn: null }
    const wed1130 = new Date('2026-11-18T04:30:00Z')
    expect(nextWeeklyFire(wed1130, slot, () => false)).toEqual(wed1130)
    expect(nextWeeklyFire(wed1130, slot, (ws) => ws === '2026-11-16')?.toISOString()).toBe('2026-11-25T04:00:00.000Z')
    expect(nextWeeklyFire(wed1130, { ...slot, lastSentOn: '2026-11-18' }, () => false)?.toISOString()).toBe('2026-11-25T04:00:00.000Z')
    expect(nextWeeklyFire(new Date('2026-11-18T03:00:00Z'), slot, () => false)?.toISOString()).toBe('2026-11-18T04:00:00.000Z')
  })
})

describe('/demo 1:1 chat with the Rich Menu', () => {
  it('"Dashboard" sent 1:1 gets a reply in direct.<persona> with a LIFF Dashboard link', async () => {
    const demo = fresh()
    const lens = groupLens(demo)
    const { messageId } = await sim('send', { persona: 'tae', type: 'text', text: 'Dashboard', direct: true })
    await demo.idle()
    const thread = simState(demo).direct.tae
    expect(thread.map((c) => c.from)).toEqual(['user', 'bot'])
    expect(thread[0]).toMatchObject({ persona: 'tae', messageId, message: { type: 'text', text: 'Dashboard' } })
    expect(thread[1].via).toBe('reply')
    expect(json(thread[1])).toContain('https://liff.line.me/demo-liff?view=dashboard')
    expect(groupLens(demo)).toEqual(lens)
    // A reply is free.
    expect(demo.world.quota.used).toBe(0)
  })

  it('"ตั้งค่า" lists the groups the persona is in, each with its Settings link', async () => {
    const demo = fresh()
    await sim('send', { persona: 'bomb', type: 'text', text: 'ตั้งค่า', direct: true })
    await demo.idle()
    const reply = json(simState(demo).direct.bomb.at(-1))
    expect(reply).toContain('เลือกกลุ่มที่จะตั้งค่า')
    expect(reply).toContain('ทีมพิตช์ NongJoDII')
    expect(reply).toContain('ลูกค้า ร้านกาแฟ')
    expect(reply).not.toContain('ทีม Dev')
    expect(reply).toContain('view=settings')
  })

  it('1:1 messages, replies, follow and postbacks never appear in any group chat', async () => {
    const demo = fresh()
    const before = demo.world.groups.map((g) => [...g.chat])
    for (const text of ['Dashboard', 'งานของฉัน', 'ตั้งค่า', 'เชื่อมต่อ Google Drive', 'สวัสดี']) {
      await sim('send', { persona: 'nont', type: 'text', text, direct: true })
    }
    await sim('follow', { persona: 'jeff' })
    await sim('postback', { persona: 'jeff', data: 'a=drive_later', direct: true })
    await demo.idle()
    demo.world.groups.forEach((g, i) => expect(g.chat).toEqual(before[i]))
    const nont = simState(demo).direct.nont
    expect(nont.filter((c) => c.from === 'user')).toHaveLength(5)
    expect(nont.filter((c) => c.from === 'bot')).toHaveLength(5)
    // The Drive words and any other text get the Google Drive card.
    expect(json(nont.at(-1))).toContain('view=google')
    expect(json(simState(demo).direct.jeff.at(-1))).toContain('view=google')
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
    // Not opened: every bot answer is unread, the user's own lines are not counted apart.
    expect(simState(demo).directChats.find((d) => d.persona === 'nont')?.unread).toBe(10)
  })

  it('a 1:1 message must be text, and open-direct takes a persona or null', async () => {
    fresh()
    expect((await runSimAction('send', 'POST', { persona: 'nont', type: 'sticker', direct: true })).status).toBe(400)
    expect((await runSimAction('open-direct', 'POST', { persona: 'nobody' })).status).toBe(404)
    expect(await sim('open-direct', { persona: null })).toEqual({ openDirect: null })
  })
})
