import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadDashboard, type DashboardData } from '@/server/dashboard/load'
import { DemoLlm } from '@/server/demo/demo-llm'
import { resetDemo, type Demo } from '@/server/demo/demo-deps'
import { demoLiffPost } from '@/server/demo/liff-api'
import { FALLBACK_GROUPS, readGroupFiles, setGroupsDir } from '@/server/demo/group-files'
import { runSimAction, simState } from '@/server/demo/sim'
import type { ChatItem } from '@/server/demo/types'
import { loadSetup } from '@/server/setup/load'
import type { SetupLoad } from '@/server/setup/types'

// Phase 6: one PM (Nont) in several LINE groups, one Dashboard.

// Every test gets its own folder with the three seed groups: create-group writes there. Only
// the first group-files test reads the shipped folder.
const SHIPPED = path.join(process.cwd(), 'src', 'app', 'demo', 'groups')
const SEED_FILES = ['01-main.json', '02-dev.json', '03-cafe.json']
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'demo-groups-test-'))
  for (const { file, def } of FALLBACK_GROUPS) await writeFile(path.join(dir, file), JSON.stringify(def))
  setGroupsDir(dir)
})
afterEach(async () => {
  vi.useRealTimers()
  setGroupsDir()
  await rm(dir, { recursive: true, force: true })
})

function fresh(setup = true) {
  return resetDemo({ setup, llm: new DemoLlm({ inner: null }) })
}

async function sim(action: string, body: unknown = {}) {
  const res = await runSimAction(action, 'POST', body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Record<string, unknown>
}

const NONT = 'Udemo0000000000000000000000000a01'
const JEFF = 'Udemo0000000000000000000000000a04'

/** A demo LIFF call, as the drawer makes it (the setup outcome is recorded after it). */
async function liff(p: string, body: unknown) {
  const res = (await demoLiffPost(p, new Request('http://localhost/demo/api/x', { method: 'POST', body: JSON.stringify(body) })))!
  const json: unknown = await res.json()
  expect(res.status, JSON.stringify(json)).toBe(200)
  return json
}

/** The setup form as Nont sends it for a group the bot knows Nont and Jeff in. */
function setupBody(groupId: string, p: Record<string, unknown> = {}) {
  return {
    idToken: `demo:${NONT}`, groupId, workDescription: 'งานทดสอบ',
    features: { summarize: true, saveFiles: true, trackRemind: true, weeklySummary: true },
    dailyReminderTime: '09:00', weeklySummaryWeekday: 1, weeklySummaryTime: '09:00',
    members: [{ lineUserId: NONT, nicknames: ['นนท์'], role: 'manager' }, { lineUserId: JEFF, nicknames: ['เจฟ'], role: 'marketing' }],
    ownerLineUserId: NONT, tagSet: ['งาน'], ...p,
  }
}
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

  it('create-group: the bot joins with the say-hi card and knows no one; say-hi makes everyone live', async () => {
    const demo = fresh()
    const { lineGroupId } = await sim('create-group', { name: 'ทีมอีเวนต์', members: ['nont', 'jeff'] })
    await demo.idle()
    let state = simState(demo)
    expect(state.selectedGroup).toBe(lineGroupId)
    expect(state.group).toEqual({ lineGroupId, name: 'ทีมอีเวนต์', botInGroup: true })
    expect(state.chat.filter((c) => c.from === 'user')).toHaveLength(0)
    const card = JSON.stringify(state.chat)
    expect(card).toContain('https://liff.line.me/demo-liff?view=setup')
    expect(card).toContain('ทักน้องจดดี')
    const info = () => simState(demo).groups.find((g) => g.lineGroupId === lineGroupId)!
    expect(info()).toMatchObject({ projectName: null, unknownMembers: ['nont', 'jeff'] })

    const row = demo.store.tables.groups.find((g) => g.lineGroupId === lineGroupId)!
    expect(row.projectId).toBeNull()
    expect(demo.store.tables.group_members.filter((m) => m.groupId === row.id)).toEqual([])
    const before = await loadSetup(demo.deps, { idToken: `demo:${NONT}`, groupId: row.id })
    expect(before.status).toBe(200)
    // Opening the form makes the opener known, as in LINE; Jeff is not yet.
    expect((before.body as SetupLoad).members.map((m) => m.displayName)).toEqual(['Nont'])

    expect(await sim('say-hi', { group: lineGroupId })).toEqual({ greeted: ['jeff'] })
    await demo.idle()
    state = simState(demo)
    const greetings = state.chat.filter((c) => c.from === 'user').map((c) => (c.message as { text: string }).text)
    expect(greetings).toHaveLength(1)
    expect(info().unknownMembers).toEqual([])
    const after = await loadSetup(demo.deps, { idToken: `demo:${NONT}`, groupId: row.id })
    expect((after.body as SetupLoad).members.map((m) => m.displayName).sort()).toEqual(['Jeff', 'Nont'])
    // Nobody left to greet: say-hi sends nothing.
    expect(await sim('say-hi', { group: lineGroupId })).toEqual({ greeted: [] })
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('create-group has no Sub group shortcut: attaching goes through setup/submit, and the Dashboard lists the group', async () => {
    const demo = fresh()
    const coffee = groupId(demo, 'ลูกค้า ร้านกาแฟ')
    expect((await runSimAction('create-group', 'POST', { name: 'x', members: ['nont'], mode: 'sub-group', parentGroup: coffee })).status).toBe(400)
    expect((await runSimAction('create-group', 'POST', { name: '', members: ['nont'] })).status).toBe(400)
    expect((await runSimAction('create-group', 'POST', { name: 'x', members: ['nope'] })).status).toBe(404)

    const { lineGroupId } = await sim('create-group', { name: 'ถ่ายรูปเมนู', members: ['nont', 'jeff'] })
    await sim('say-hi')
    await demo.idle()
    const row = demo.store.tables.groups.find((g) => g.lineGroupId === lineGroupId)!
    expect((await dashboardAs(demo, NONT)).groups.map((g) => g.name)).not.toContain('ถ่ายรูปเมนู')
    const parent = demo.store.tables.groups.find((g) => g.lineGroupId === coffee)!
    await liff('setup/submit', setupBody(row.id, { attachProjectId: parent.projectId }))
    await demo.idle()
    expect(demo.store.tables.groups.find((g) => g.id === row.id)).toMatchObject({ projectId: parent.projectId, nominatedOwnerLineUserId: NONT })
    expect(simState(demo).groups.find((g) => g.lineGroupId === lineGroupId)).toMatchObject({ isSubGroup: true, projectName: 'ลูกค้า ร้านกาแฟ' })
    const data = await dashboardAs(demo, NONT)
    expect(data.groups.map((g) => g.name)).toContain('ถ่ายรูปเมนู')
    expect(data.groups).toHaveLength(4)
  })

  it('a new Project through the setup form: listed on the Dashboard once the Owner confirms', async () => {
    const demo = fresh()
    const { lineGroupId } = await sim('create-group', { name: 'ทีมอีเวนต์', members: ['nont', 'jeff'] })
    await sim('say-hi')
    await demo.idle()
    const row = demo.store.tables.groups.find((g) => g.lineGroupId === lineGroupId)!
    // Nont names Jeff the Owner: the group waits for Jeff to confirm.
    await liff('setup/submit', setupBody(row.id, { ownerLineUserId: JEFF }))
    await demo.idle()
    expect((await dashboardAs(demo, NONT)).groups.map((g) => g.name)).not.toContain('ทีมอีเวนต์')
    await liff('setup/confirm-owner', { idToken: `demo:${JEFF}`, groupId: row.id })
    await demo.idle()
    expect(simState(demo).groups.find((g) => g.lineGroupId === lineGroupId)).toMatchObject({ isSubGroup: false, projectName: 'ทีมอีเวนต์' })
    expect((await dashboardAs(demo, NONT)).groups.map((g) => g.name)).toContain('ทีมอีเวนต์')
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

/** The seeded world as plain data, times relative to the reset instant. */
function seedShape(demo: Demo) {
  const now = demo.world.now().getTime()
  const rel = (d: Date | null | undefined) => (d ? d.getTime() - now : null)
  const { tables } = demo.store
  return demo.world.groups.map((g) => {
    const row = tables.groups.find((r) => r.lineGroupId === g.lineGroupId)!
    const setup = tables.group_setups.find((r) => r.groupId === row.id)
    const sched = tables.group_schedules.find((r) => r.groupId === row.id)
    return {
      id: g.lineGroupId, name: g.name, members: [...g.members], bot: g.botInGroup, readCount: g.readCount,
      chat: g.chat.map((c) => [c.persona, JSON.stringify(c.message), Date.parse(c.at) - now]),
      owner: row.nominatedOwnerLineUserId, confirmed: row.ownerConfirmedAt !== null, work: row.workDescription,
      project: tables.groups.filter((r) => r.projectId === row.projectId).map((r) => r.lineGroupId),
      isMain: setup?.isMain,
      weekly: sched ? [sched.weeklySummaryWeekday, sched.weeklySummaryTime, sched.dailyReminderTime] : null,
      members_: tables.group_members.filter((m) => m.groupId === row.id).map((m) => [m.lineUserId, m.nicknames, m.role, m.source, m.leftAt]),
      tasks: tables.tasks.filter((t) => t.groupId === row.id).map((t) => [
        t.title, t.assigneeLineUserId, t.status, rel(t.dueAt), rel(t.doneAt), rel(t.lastActivityAt), rel(t.announcedAt),
      ]),
    }
  })
}

describe('/demo group files (src/app/demo/groups)', () => {
  it('the 3 shipped files hold the built-in seed, and seed the same world as it does', () => {
    const errors: string[] = []
    const shipped = readGroupFiles(SHIPPED, (m) => errors.push(m)).entries.filter((e) => SEED_FILES.includes(e.file))
    expect(errors).toEqual([])
    expect(shipped).toEqual(FALLBACK_GROUPS)

    // The demo clock is real time: freeze it so both seeds read the same instant.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-18T03:20:00Z') })
    const fromFiles = fresh()
    expect(fromFiles.world.groups.map((g) => g.file)).toEqual(SEED_FILES)
    const a = seedShape(fromFiles)
    expect(fromFiles.world.log.filter((l) => l.kind === 'error')).toEqual([])
    // A missing folder: the built-in seed, the same world.
    setGroupsDir(path.join(dir, 'missing'))
    const builtIn = fresh()
    expect(seedShape(builtIn)).toEqual(a)
    // Built-in groups have no file to delete.
    expect(builtIn.world.groups.map((g) => g.file)).toEqual([null, null, null])
    vi.useRealTimers()
    expect(builtIn.world.log.filter((l) => l.kind === 'error')).toEqual([])
    expect(a.map((g) => [g.name, g.isMain, g.project.length, g.tasks.length, g.chat.length, g.readCount])).toEqual([
      ['ทีมพิตช์ NongJoDII', true, 2, 4, 3, 3],
      ['ทีม Dev', false, 2, 3, 3, 1],
      ['ลูกค้า ร้านกาแฟ', true, 1, 4, 4, 2],
    ])
  })

  it('create-group saves a not-set-up file; Reset brings it back with the setup card and no known Member', async () => {
    let demo = fresh()
    const made = await sim('create-group', { name: 'ทีมอีเวนต์', members: ['jeff', 'nont'] })
    await sim('say-hi')
    await demo.idle()
    expect(made.file).toBe('04-group.json')
    expect(JSON.parse(await readFile(path.join(dir, '04-group.json'), 'utf8'))).toEqual({
      name: 'ทีมอีเวนต์', lineGroupId: made.lineGroupId, members: ['jeff', 'nont'], setUp: false,
    })
    // A refused create writes nothing.
    expect((await runSimAction('create-group', 'POST', { name: 'x', members: ['nope'] })).status).toBe(404)
    expect((await readdir(dir)).sort()).toEqual([...SEED_FILES, '04-group.json'])

    demo = fresh()
    const info = simState(demo).groups.find((g) => g.lineGroupId === made.lineGroupId)!
    expect(info).toMatchObject({ botInGroup: true, projectName: null, file: '04-group.json', unknownMembers: ['nont', 'jeff'] })
    const g = demo.world.groupById(made.lineGroupId as string)!
    expect(JSON.stringify(g.chat)).toContain('https://liff.line.me/demo-liff?view=setup')
    const row = demo.store.tables.groups.find((r) => r.lineGroupId === made.lineGroupId)!
    expect(row).toMatchObject({ projectId: null, ownerConfirmedAt: null, name: 'ทีมอีเวนต์' })
    expect(demo.store.tables.group_members.filter((m) => m.groupId === row.id)).toEqual([])
    expect((await dashboardAs(demo, NONT)).groups).toHaveLength(3)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
    // The setup card's link opens the form for this row.
    await sim('say-hi')
    await demo.idle()
    expect((await loadSetup(demo.deps, { idToken: `demo:${NONT}`, groupId: row.id })).status).toBe(200)
    // A new group never takes an id a file holds.
    const third = await sim('create-group', { name: 'อีกกลุ่ม', members: ['nont'] })
    expect(third.lineGroupId).not.toBe(made.lineGroupId)
    expect(third.file).toBe('05-group.json')
  })

  it('the setup outcome is recorded in the file: Reset brings back a new Project and a Sub group set up', async () => {
    let demo = fresh()
    const coffee = groupId(demo, 'ลูกค้า ร้านกาแฟ')
    const made = await sim('create-group', { name: 'ทีมอีเวนต์', members: ['jeff', 'nont'] })
    await sim('say-hi')
    const sub = await sim('create-group', { name: 'Menu Photos!', members: ['nont', 'jeff'] })
    await sim('say-hi')
    await demo.idle()
    const rowOf = (id: unknown) => demo.store.tables.groups.find((r) => r.lineGroupId === id)!
    // Saved but not confirmed yet: the file still says not set up.
    await liff('setup/submit', setupBody(rowOf(made.lineGroupId).id, { ownerLineUserId: JEFF }))
    await demo.idle()
    expect(JSON.parse(await readFile(path.join(dir, '04-group.json'), 'utf8'))).toMatchObject({ setUp: false })
    await liff('setup/confirm-owner', { idToken: `demo:${JEFF}`, groupId: rowOf(made.lineGroupId).id })
    await liff('setup/submit', setupBody(rowOf(sub.lineGroupId).id, { attachProjectId: rowOf(coffee).projectId }))
    await demo.idle()
    expect(JSON.parse(await readFile(path.join(dir, '04-group.json'), 'utf8'))).toEqual({
      name: 'ทีมอีเวนต์', lineGroupId: made.lineGroupId, members: ['jeff', 'nont'], owner: 'jeff', mode: 'new-project',
    })
    expect(JSON.parse(await readFile(path.join(dir, '05-menu-photos.json'), 'utf8'))).toEqual({
      name: 'Menu Photos!', lineGroupId: sub.lineGroupId, members: ['nont', 'jeff'], owner: 'nont', mode: 'sub-group', parent: '03-cafe.json',
    })

    demo = fresh()
    const state = simState(demo)
    expect(state.groups.map((g) => g.name)).toEqual(['ทีมพิตช์ NongJoDII', 'ทีม Dev', 'ลูกค้า ร้านกาแฟ', 'ทีมอีเวนต์', 'Menu Photos!'])
    expect(state.groups.find((g) => g.lineGroupId === made.lineGroupId)).toMatchObject({
      botInGroup: true, projectName: 'ทีมอีเวนต์', isSubGroup: false, lastMessage: null, members: 3, unknownMembers: [],
    })
    expect(state.groups.find((g) => g.lineGroupId === sub.lineGroupId)).toMatchObject({
      botInGroup: true, projectName: 'ลูกค้า ร้านกาแฟ', isSubGroup: true, lastMessage: null, unknownMembers: [],
    })
    for (const [id, owner] of [[made.lineGroupId, JEFF], [sub.lineGroupId, NONT]]) {
      const row = rowOf(id)
      expect(row).toMatchObject({ nominatedOwnerLineUserId: owner })
      expect(row.ownerConfirmedAt).not.toBeNull()
      const live = demo.store.tables.group_members.filter((m) => m.groupId === row.id && m.leftAt === null)
      expect(live.map((m) => [m.lineUserId, m.nicknames, m.role]).sort()).toEqual([
        [NONT, ['นนท์'], 'manager'],
        [JEFF, ['เจฟ'], 'marketing'],
      ])
    }
    expect((await dashboardAs(demo, NONT)).groups).toHaveLength(5)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('delete-group: refused while a Sub group file names it as parent, works otherwise', async () => {
    let demo = fresh()
    const main = groupId(demo, 'ทีมพิตช์ NongJoDII')
    const coffee = groupId(demo, 'ลูกค้า ร้านกาแฟ')
    const sub = await sim('create-group', { name: 'ถ่ายรูปเมนู', members: ['nont', 'jeff'] })
    await sim('say-hi')
    await demo.idle()
    const subRow = demo.store.tables.groups.find((r) => r.lineGroupId === sub.lineGroupId)!
    const coffeeProject = demo.store.tables.groups.find((r) => r.lineGroupId === coffee)!.projectId
    await liff('setup/submit', setupBody(subRow.id, { attachProjectId: coffeeProject }))
    await demo.idle()

    const refused = await runSimAction('delete-group', 'POST', { group: main })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.body)).toContain('02-dev.json')
    expect((await runSimAction('delete-group', 'POST', { group: coffee })).status).toBe(400)
    expect((await runSimAction('delete-group', 'POST', { group: 'Cnope' })).status).toBe(404)
    expect((await runSimAction('delete-group', 'POST', {})).status).toBe(400)

    // The Sub group is selected (just created): deleting it selects the first group.
    expect(await sim('delete-group', { group: sub.lineGroupId })).toMatchObject({ deleted: sub.lineGroupId, file: '04-group.json', selectedGroup: main })
    expect(simState(demo).groups.map((g) => g.lineGroupId)).not.toContain(sub.lineGroupId)
    expect(demo.store.tables.groups.map((g) => g.lineGroupId)).not.toContain(sub.lineGroupId)
    expect((await dashboardAs(demo, NONT)).groups.map((g) => g.name)).not.toContain('ถ่ายรูปเมนู')

    // Now the coffee group has no child: it goes, with its Project and Tasks, after a day of
    // reminders and its weekly card wrote rows about it.
    await sim('clock', { advance: 'next0900' })
    await sim('weekly', { group: coffee })
    await demo.idle()
    const coffeeRow = demo.store.tables.groups.find((g) => g.lineGroupId === coffee)!
    await sim('delete-group', { group: coffee })
    await sim('clock', { advance: '1d' })
    await sim('weekly', { group: main })
    await demo.idle()
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
    expect(demo.store.tables.projects.map((p) => p.id)).not.toContain(coffeeRow.projectId)
    expect(demo.store.tables.tasks.filter((t) => t.groupId === coffeeRow.id)).toEqual([])
    expect((await readdir(dir)).sort()).toEqual(['01-main.json', '02-dev.json'])

    demo = fresh()
    expect(simState(demo).groups.map((g) => g.name)).toEqual(['ทีมพิตช์ NongJoDII', 'ทีม Dev'])
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('a broken group file is skipped and logged; the others still seed', async () => {
    await writeFile(path.join(dir, '04-broken.json'), '{ not json')
    await writeFile(path.join(dir, '05-no-members.json'), JSON.stringify({ name: 'x', lineGroupId: 'Cdemo9', owner: 'nont', mode: 'new-project' }))
    await writeFile(path.join(dir, '06-orphan.json'), JSON.stringify({ name: 'y', lineGroupId: 'Cdemo8', members: ['nont'], owner: 'nont', mode: 'sub-group', parent: '99-gone.json' }))
    await writeFile(path.join(dir, '07-dup-id.json'), JSON.stringify({ name: 'z', lineGroupId: 'Cdemo0000000000000000000000000001', members: ['nont'], owner: 'nont', mode: 'new-project' }))
    await writeFile(path.join(dir, 'bad name.json'), '{}')
    await writeFile(path.join(dir, 'notes.txt'), 'ignored')
    const demo = fresh()
    expect(simState(demo).groups.map((g) => g.name)).toEqual(['ทีมพิตช์ NongJoDII', 'ทีม Dev', 'ลูกค้า ร้านกาแฟ'])
    const errors = demo.world.log.filter((l) => l.kind === 'error').map((l) => l.summary)
    expect(errors).toHaveLength(5)
    for (const f of ['04-broken.json', '05-no-members.json', '06-orphan.json', '07-dup-id.json', 'bad name.json']) {
      expect(errors.some((e) => e.includes(f)), f).toBe(true)
    }
  })

  it('reset {setup:false} ignores the folder', async () => {
    await writeFile(path.join(dir, '04-extra.json'), JSON.stringify({ name: 'extra', lineGroupId: 'Cdemo7', members: ['nont'], owner: 'nont', mode: 'new-project' }))
    const demo = fresh(false)
    expect(simState(demo).groups.map((g) => [g.name, g.file])).toEqual([['ทีมพิตช์ NongJoDII', null]])
  })
})
