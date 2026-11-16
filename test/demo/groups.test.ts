import { describe, expect, it } from 'vitest'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import { DemoLlm } from '@/server/demo/demo-llm'
import { resetDemo, type Demo } from '@/server/demo/demo-deps'
import { runSimAction, simState } from '@/server/demo/sim'
import type { ChatItem } from '@/server/demo/types'
import { loadSetup } from '@/server/setup/load'
import type { SetupLoad } from '@/server/setup/types'

// Phase 6: one PM (Nont) in several LINE groups, one Dashboard.

function fresh(setup = true) {
  return resetDemo({ setup, llm: new DemoLlm({ inner: null }) })
}

async function sim(action: string, body: unknown = {}) {
  const res = await runSimAction(action, 'POST', body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Record<string, unknown>
}

const NONT = 'Udemo0000000000000000000000000a01'
const reviewCards = (chat: ChatItem[]) =>
  chat.filter((c) => c.from === 'bot' && c.message.type === 'flex' && JSON.stringify(c.message).includes('view=review'))

function groupId(demo: Demo, name: string): string {
  const g = demo.world.groups.find((x) => x.name === name)
  if (!g) throw new Error(`no group ${name}`)
  return g.lineGroupId
}

async function dashboardAs(demo: Demo, lineUserId: string): Promise<DashboardData> {
  const res = await loadDashboard(demo.deps, { idToken: `demo:${lineUserId}` })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as DashboardData
}

describe('/demo with many groups', () => {
  it('the seed: 3 groups with Nont in all, the bot in each, Tasks, and the Dashboard as Nont lists all 3', async () => {
    const demo = fresh()
    const state = simState(demo)
    expect(state.groups.map((g) => [g.name, g.botInGroup, g.isSubGroup, g.projectName])).toEqual([
      ['ทีมพิตช์ NongJoDII', true, false, 'ทีมพิตช์ NongJoDII'],
      ['ทีม Dev', true, true, 'ทีมพิตช์ NongJoDII'],
      ['ลูกค้า ร้านกาแฟ', true, false, 'ลูกค้า ร้านกาแฟ'],
    ])
    expect(state.selectedGroup).toBe(state.group.lineGroupId)
    expect(state.groups.every((g) => g.lastMessage !== null)).toBe(true)
    // One Owner per Project: Nont is the confirmed Owner of every group.
    expect(demo.store.tables.groups.every((g) => g.nominatedOwnerLineUserId === NONT && g.ownerConfirmedAt !== null)).toBe(true)
    expect(new Set(demo.store.tables.groups.map((g) => g.projectId)).size).toBe(2)

    const data = await dashboardAs(demo, NONT)
    expect(data.role).toBe('pm')
    expect(data.groups.map((g) => g.name).sort()).toEqual(['ทีมพิตช์ NongJoDII', 'ทีม Dev', 'ลูกค้า ร้านกาแฟ'].sort())
    const now = demo.world.now().getTime()
    for (const g of data.groups) {
      expect(g.access).toBe('overview')
      expect(g.tasks.length).toBeGreaterThanOrEqual(3)
      expect(g.tasks.some((t) => t.status === 'done')).toBe(true)
      expect(g.tasks.filter((t) => t.status !== 'done' && t.dueAt !== null && Date.parse(t.dueAt) < now)).toHaveLength(1)
    }

    // Tae (a Member, not a PM) sees only the two groups he is in.
    const tae = await dashboardAs(demo, 'Udemo0000000000000000000000000a02')
    expect(tae.role).toBe('member')
    expect(tae.groups.map((g) => g.name).sort()).toEqual(['ทีม Dev', 'ทีมพิตช์ NongJoDII'].sort())
  })

  it('two groups: messages and bot replies stay in their own group', async () => {
    const demo = fresh()
    const main = groupId(demo, 'ทีมพิตช์ NongJoDII')
    const dev = groupId(demo, 'ทีม Dev')
    const mainBefore = demo.world.groupById(main)!.chat.length

    await sim('send', { group: dev, persona: 'nont', type: 'text', text: 'ฝากเต้ทำหน้าเข้าสู่ระบบให้เสร็จพรุ่งนี้นะ' })
    await sim('send', { group: dev, persona: 'tae', type: 'text', text: 'ได้ครับ' })
    await sim('send', { group: dev, persona: 'nont', type: 'text', text: 'NongJoDII สรุปหน่อย' })
    await demo.idle()

    const devChat = demo.world.groupById(dev)!.chat
    expect(reviewCards(devChat)).toHaveLength(1)
    expect(demo.world.groupById(main)!.chat).toHaveLength(mainBefore)
    // The store saw the messages in Dev's row only.
    const devRow = demo.store.tables.groups.find((g) => g.lineGroupId === dev)!
    expect(new Set(demo.store.tables.messages.map((m) => m.groupId))).toEqual(new Set([devRow.id]))
    // The selected group (main) did not change; the state shows its chat.
    expect(simState(demo).chat).toHaveLength(mainBefore)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('the unread count rises for a group that is not selected, and selecting it clears it', async () => {
    const demo = fresh()
    const coffee = groupId(demo, 'ลูกค้า ร้านกาแฟ')
    const unread = () => simState(demo).groups.find((g) => g.lineGroupId === coffee)!.unread
    const before = unread()
    await sim('send', { group: coffee, persona: 'bomb', type: 'text', text: 'ส่งโลโก้ให้ดูแล้วนะคะ' })
    await sim('send', { group: coffee, persona: 'jeff', type: 'text', text: 'สวยมากครับ' })
    await demo.idle()
    expect(unread()).toBe(before + 2)
    const row = simState(demo).groups.find((g) => g.lineGroupId === coffee)!
    expect(row.lastMessage?.text).toBe('Jeff: สวยมากครับ')

    await sim('select-group', { group: coffee })
    const state = simState(demo)
    expect(state.selectedGroup).toBe(coffee)
    expect(state.group.name).toBe('ลูกค้า ร้านกาแฟ')
    expect(unread()).toBe(0)
    expect(state.personas.filter((p) => p.inGroup).map((p) => p.key)).toEqual(['nont', 'bomb', 'jeff'])
    expect((await runSimAction('select-group', 'POST', { group: 'Cnope' })).status).toBe(404)
  })

  it('create-group new-project: the bot joins, learns the members silently, and the setup form lists them', async () => {
    const demo = fresh()
    const { lineGroupId } = await sim('create-group', { name: 'ทีมอีเวนต์', members: ['nont', 'jeff'], mode: 'new-project' })
    await demo.idle()
    const state = simState(demo)
    expect(state.selectedGroup).toBe(lineGroupId)
    expect(state.group).toEqual({ lineGroupId, name: 'ทีมอีเวนต์', botInGroup: true })
    expect(state.chat.filter((c) => c.from === 'user')).toHaveLength(0)
    expect(JSON.stringify(state.chat)).toContain('https://liff.line.me/demo-liff?view=setup')

    const row = demo.store.tables.groups.find((g) => g.lineGroupId === lineGroupId)!
    expect(row.projectId).toBeNull()
    expect(row.name).toBe('ทีมอีเวนต์')
    const res = await loadSetup(demo.deps, { idToken: `demo:${NONT}`, groupId: row.id })
    expect(res.status).toBe(200)
    expect((res.body as SetupLoad).members.map((m) => m.displayName).sort()).toEqual(['Jeff', 'Nont'])
  })

  it('create-group sub-group: attached to the parent Project with its Owner; the Dashboard as Nont lists 4 groups', async () => {
    const demo = fresh()
    const coffee = groupId(demo, 'ลูกค้า ร้านกาแฟ')
    // A Sub group needs the Project's Owner among its members (one admin per Project).
    expect((await runSimAction('create-group', 'POST', { name: 'x', members: ['bomb'], mode: 'sub-group', parentGroup: coffee })).status).toBe(400)
    expect((await runSimAction('create-group', 'POST', { name: 'x', members: ['nont'], mode: 'sub-group', parentGroup: 'Cnope' })).status).toBe(404)
    expect((await runSimAction('create-group', 'POST', { name: '', members: ['nont'], mode: 'new-project' })).status).toBe(400)

    const { lineGroupId } = await sim('create-group', { name: 'ถ่ายรูปเมนู', members: ['nont', 'jeff'], mode: 'sub-group', parentGroup: coffee })
    await demo.idle()
    const info = simState(demo).groups.find((g) => g.lineGroupId === lineGroupId)!
    expect(info).toMatchObject({ isSubGroup: true, projectName: 'ลูกค้า ร้านกาแฟ', botInGroup: true })
    const row = demo.store.tables.groups.find((g) => g.lineGroupId === lineGroupId)!
    const parent = demo.store.tables.groups.find((g) => g.lineGroupId === coffee)!
    expect(row.projectId).toBe(parent.projectId)
    expect(row.nominatedOwnerLineUserId).toBe(NONT)
    const data = await dashboardAs(demo, NONT)
    expect(data.groups.map((g) => g.name)).toContain('ถ่ายรูปเมนู')
    expect(data.groups).toHaveLength(4)
  })

  it('plays a script into a chosen group: speakers outside it join first, only that group gets the Summary', async () => {
    const demo = fresh()
    const dev = groupId(demo, 'ทีม Dev')
    const others = demo.world.groups.filter((g) => g.lineGroupId !== dev).map((g) => [g.lineGroupId, g.chat.length] as const)
    const res = await sim('load-script', { name: '01-clear-task', delayMs: 0, group: dev })
    expect((res.joined as string[]).sort()).toEqual(['bomb', 'jeff'])
    await demo.idle()
    expect(reviewCards(demo.world.groupById(dev)!.chat)).toHaveLength(1)
    for (const [id, len] of others) expect(demo.world.groupById(id)!.chat).toHaveLength(len)
    expect([...demo.world.groupById(dev)!.members].sort()).toEqual(['bomb', 'jeff', 'nont', 'tae'])
  })

  it('reset {setup:false} keeps the single fresh group for onboarding', () => {
    const demo = fresh(false)
    const state = simState(demo)
    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]).toMatchObject({ name: 'ทีมพิตช์ NongJoDII', botInGroup: false, projectName: null, unread: 0 })
    expect(demo.store.tables.groups).toHaveLength(0)
  })

  it('the daily tick on the seeded world: no error, nobody marked as left', async () => {
    const demo = fresh()
    const lens = demo.world.groups.map((g) => g.chat.length)
    await sim('clock', { advance: 'next0900' })
    await demo.idle()
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
    expect(demo.store.tables.group_members.filter((m) => m.leftAt !== null)).toEqual([])
    const leftLines = demo.world.groups.flatMap((g) => g.chat).filter((c) => c.from === 'system' && JSON.stringify(c.message).includes('ออกจากกลุ่ม'))
    expect(leftLines).toEqual([])
    // Each group got its own reminders or flags (if any), never another group's.
    demo.world.groups.forEach((g, i) => expect(g.chat.length).toBeGreaterThanOrEqual(lens[i]))
  })
})
