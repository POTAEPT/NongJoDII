import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DemoLlm } from '@/server/demo/demo-llm'
import { getDemo, resetDemo } from '@/server/demo/demo-deps'
import { nextBangkok0900, readScripts, runSimAction, setScriptsDir, simState } from '@/server/demo/sim'
import { loadSetup } from '@/server/setup/load'
import type { SetupLoad } from '@/server/setup/types'
import type { ChatItem } from '@/server/demo/types'

function fresh(setup = true) {
  return resetDemo({ setup, llm: new DemoLlm({ inner: null }) })
}

async function sim(action: string, body: unknown = {}) {
  const res = await runSimAction(action, 'POST', body)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body as Record<string, unknown>
}

const flexes = (chat: ChatItem[]) => chat.filter((c) => c.from === 'bot' && c.message.type === 'flex')

describe('/demo full in-process run', () => {
  it('reset, join, three messages, the summary command: a summary flex with a demo-liff review link', async () => {
    const demo = fresh()
    expect(simState(demo).group.botInGroup).toBe(true)
    const seeded = demo.world.chat.length

    await sim('send', { persona: 'nont', type: 'text', text: 'สไลด์พิตช์ยังเป็นของรอบแรกอยู่เลย' })
    await sim('send', { persona: 'nont', type: 'text', text: 'ฝากบอมอัปเดตสไลด์พิตช์ทั้งเด็คด้วยนะ' })
    await sim('send', { persona: 'bomb', type: 'text', text: 'ได้ค่ะ พรุ่งนี้ห้าโมงเย็นส่งนะคะ' })
    const { messageId } = await sim('send', { persona: 'nont', type: 'text', text: 'NongJoDII สรุปหน่อย' })
    expect(typeof messageId).toBe('string')
    await demo.idle()

    const state = simState(demo)
    expect(state.chat.slice(seeded).filter((c) => c.from === 'user')).toHaveLength(4)
    const cards = flexes(state.chat).map((c) => JSON.stringify(c.message))
    const summary = cards.find((c) => c.includes('view=review'))
    expect(summary, JSON.stringify(state.log, null, 1)).toBeDefined()
    expect(summary).toContain('https://liff.line.me/demo-liff?view=review&id=')
    expect(state.ai.lastCallFallback).toBe(true)
    expect(demo.store.tables.task_candidates).toHaveLength(1)
  })

  it('does not deliver to a bot that is not in the group, but shows the message', async () => {
    const demo = fresh(false)
    await sim('send', { persona: 'tae', type: 'text', text: 'สวัสดี' })
    await demo.idle()
    expect(demo.world.chat).toHaveLength(1)
    expect(demo.store.tables.messages).toHaveLength(0)
  })

  it('handles mentions, stickers, images, unsend and member join and leave', async () => {
    const demo = fresh()
    await sim('join')
    const t = await sim('send', { persona: 'nont', type: 'text', text: 'ดูนี่หน่อย', mentions: ['tae'] })
    expect(demo.world.chat.at(-1)?.message).toEqual({ type: 'text', text: '@Tae ดูนี่หน่อย' })
    await sim('send', { persona: 'tae', type: 'sticker' })
    const img = await sim('send', { persona: 'bomb', type: 'image', fileName: 'a.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64') })
    expect(demo.world.chat.at(-1)?.message).toEqual({ type: 'image', url: `/demo/api/sim/content/${img.messageId as string}`, fileName: 'a.png' })
    await sim('unsend', { persona: 'nont', messageId: t.messageId })
    expect(demo.world.chat.find((c) => c.messageId === t.messageId)?.unsent).toBe(true)
    await sim('member-leave', { persona: 'bomb' })
    expect(simState(demo).personas.find((p) => p.key === 'bomb')?.inGroup).toBe(false)
    await sim('member-join', { persona: 'bomb' })
    await demo.idle()
    expect(simState(demo).personas.find((p) => p.key === 'bomb')?.inGroup).toBe(true)
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])
  })

  it('a fresh (not set up) group gets the setup card on join', async () => {
    const demo = fresh(false)
    await sim('join')
    await demo.idle()
    const card = flexes(demo.world.chat).map((c) => JSON.stringify(c.message)).join('\n')
    expect(card).toContain('https://liff.line.me/demo-liff?view=setup')
  })

  it('a fresh group: join adds no Member (#151); say-hi makes all four live, with no role', async () => {
    const demo = fresh(false)
    await sim('join')
    await demo.idle()
    // No greeting bubbles and no message events: only the join line and the setup card.
    expect(demo.world.chat.filter((c) => c.from === 'user')).toHaveLength(0)
    expect(demo.store.tables.messages).toHaveLength(0)
    expect(demo.store.tables.group_members).toHaveLength(0)
    expect(simState(demo).groups[0].unknownMembers.sort()).toEqual(['bomb', 'jeff', 'nont', 'tae'])

    await sim('say-hi')
    await demo.idle()
    expect(demo.world.chat.filter((c) => c.from === 'user')).toHaveLength(4)
    expect(simState(demo).groups[0].unknownMembers).toEqual([])
    const group = demo.store.tables.groups[0]
    const nominee = demo.world.persona('nont')!.lineUserId
    const res = await loadSetup(demo.deps, { idToken: `demo:${nominee}`, groupId: group.id })
    expect(res.status).toBe(200)
    const members = (res.body as SetupLoad).members
    expect(members.map((m) => m.displayName).sort()).toEqual(['Bomb', 'Jeff', 'Nont', 'Tae'])
    expect(members.every((m) => m.role === null)).toBe(true)

    // A second join learns no one and adds no one twice.
    await sim('join')
    await demo.idle()
    expect(demo.store.tables.group_members).toHaveLength(4)
    // say-hi needs the bot in the group.
    await sim('leave-bot')
    expect((await runSimAction('say-hi', 'POST', {})).status).toBe(400)
  })

  it('a set-up group: join adds no chat bubbles from people', async () => {
    const demo = fresh()
    const before = demo.world.chat.length
    await sim('join')
    await demo.idle()
    expect(demo.world.chat.slice(before).filter((c) => c.from === 'user')).toHaveLength(0)
  })

  it('reads the scripts folder: a broken file is skipped and logged, a traversal name is refused', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'demo-scripts-'))
    try {
      await writeFile(path.join(dir, '10-ok.json'), JSON.stringify({ name: 'ok', description: 'd', messages: [{ persona: 'nont', text: 'hi' }] }))
      await writeFile(path.join(dir, '20-broken.json'), '{ not json')
      await writeFile(path.join(dir, '30-no-messages.json'), JSON.stringify({ name: 'x' }))
      await writeFile(path.join(dir, 'notes.txt'), 'ignored')
      const errors: string[] = []
      expect((await readScripts(dir, (m) => errors.push(m))).map((s) => s.name)).toEqual(['10-ok'])
      expect(errors).toHaveLength(2)

      const demo = fresh()
      setScriptsDir(dir)
      const listed = await runSimAction('scripts', 'GET', null)
      expect(listed.body).toEqual({ scripts: [{ name: '10-ok', description: 'd', messages: 1 }] })
      expect(demo.world.log.filter((l) => l.kind === 'error')).toHaveLength(2)
      for (const name of ['../scripts/01-clear-task', '..', '/etc/passwd', 'a/b', '.hidden']) {
        expect((await runSimAction('load-script', 'POST', { name })).status, name).toBe(400)
      }
      expect((await runSimAction('load-script', 'POST', { name: 'missing' })).status).toBe(404)
      expect((await runSimAction('load-script', 'POST', { name: '10-ok', delayMs: 0 })).status).toBe(200)
      await demo.idle()
    } finally {
      setScriptsDir()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists the shipped scripts in file-name order', async () => {
    fresh()
    const res = await runSimAction('scripts', 'GET', null)
    expect((res.body as { scripts: Array<{ name: string }> }).scripts.map((s) => s.name)).toEqual([
      '01-clear-task', '02-casual-no-task', '03-several-tasks',
    ])
  })

  it('plays a script with several tasks', async () => {
    const demo = fresh()
    await sim('join')
    await sim('load-script', { name: '03-several-tasks', delayMs: 0 })
    await demo.idle()
    expect(demo.store.tables.task_candidates.map((c) => c.title)).toEqual([
      'ทำเดโมแอปให้รันได้ครบทุกหน้า', 'ออกแบบโปสเตอร์งานพิตช์ ขนาด A1', 'จองห้องซ้อมที่ตึก 3',
    ])
  })

  it('plays the clear-task script (one task for Bomb) and the lunch script (no task)', async () => {
    const demo = fresh()
    await sim('join')
    await sim('load-script', { name: '01-clear-task', delayMs: 0 })
    await demo.idle()
    const bomb = demo.world.persona('bomb')!.lineUserId
    expect(demo.store.tables.task_candidates.map((c) => [c.title, c.suggestedAssigneeLineUserId, c.suggestedDueAt !== null])).toEqual([
      ['อัปเดตสไลด์พิตช์ทั้งเด็ค ใส่ตัวเลข break-even ใหม่', bomb, true],
    ])

    const lunch = fresh()
    await sim('join')
    await sim('load-script', { name: '02-casual-no-task.json', delayMs: 0 })
    await lunch.idle()
    expect(lunch.store.tables.task_candidates).toHaveLength(0)
    expect(lunch.store.tables.summaries).toHaveLength(1)
  })

  it('builds postback, file, quoted text and tick events, and leave-bot stops delivery', async () => {
    const demo = fresh()
    await sim('join')
    const f = await sim('send', { persona: 'tae', type: 'file', fileName: 'สรุป.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF').toString('base64') })
    expect(demo.world.chat.at(-1)?.message).toMatchObject({ type: 'file', fileName: 'สรุป.pdf', size: 4 })
    const q = await sim('send', { persona: 'nont', type: 'text', text: 'NongJoDII ขอไฟล์', quotedMessageId: f.messageId })
    expect(demo.world.chat.find((c) => c.messageId === q.messageId)?.message).toMatchObject({ quotedMessageId: f.messageId })
    await sim('postback', { persona: 'nont', data: 'action=unknown', params: { date: '2026-11-20' } })
    await sim('tick')
    await demo.idle()
    expect(demo.world.log.filter((l) => l.kind === 'error')).toEqual([])

    await sim('leave-bot')
    await demo.idle()
    expect(simState(demo).group.botInGroup).toBe(false)
    const stored = demo.store.tables.messages.length
    await sim('send', { persona: 'tae', type: 'text', text: 'ยังอยู่ไหม' })
    await demo.idle()
    expect(demo.store.tables.messages).toHaveLength(stored)
  })

  it('a reset stops a playing script and starts clean', async () => {
    const old = fresh()
    await sim('join')
    await sim('load-script', { name: '01-clear-task', delayMs: 5 })
    const next = fresh()
    await old.idle()
    expect(getDemo()).toBe(next)
    expect(next.world.chat.filter((c) => c.from === 'bot')).toHaveLength(0)
    expect(next.world.chat).toHaveLength(3) // the seeded lines only
  })

  it('moves the clock, runs the tick, sets the quota and adds a persona', async () => {
    const demo = fresh()
    const before = demo.world.now().getTime()
    await sim('clock', { advance: '1d' })
    expect(demo.world.now().getTime() - before).toBeGreaterThanOrEqual(86_400_000)
    expect(demo.world.log.some((l) => l.kind === 'tick')).toBe(true)
    expect(await sim('quota', { limit: 10, used: 9 })).toEqual({ quota: { limit: 10, used: 9 } })
    const { persona } = await sim('persona', { key: 'bank', lineName: 'Bank', role: 'researcher' })
    expect(persona).toMatchObject({ key: 'bank', lineUserId: 'Udemo0000000000000000000000000a05' })
    expect(simState(demo).personas.find((p) => p.key === 'bank')?.inGroup).toBe(false)
    expect((persona as { lineUserId: string }).lineUserId).toHaveLength(33)
    expect((await runSimAction('send', 'POST', { persona: 'nobody', text: 'x' })).status).toBe(404)
  })

  it('finds the next Bangkok 09:00 and Monday 09:00', () => {
    // Monday 2026-11-16 10:00 Bangkok
    const now = new Date('2026-11-16T03:00:00Z')
    expect(nextBangkok0900(now).toISOString()).toBe('2026-11-17T02:00:00.000Z')
    expect(nextBangkok0900(now, 1).toISOString()).toBe('2026-11-23T02:00:00.000Z')
    expect(nextBangkok0900(new Date('2026-11-16T01:00:00Z'), 1).toISOString()).toBe('2026-11-16T02:00:00.000Z')
  })
})
