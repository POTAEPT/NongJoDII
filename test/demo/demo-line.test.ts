import { describe, expect, it } from 'vitest'
import { DemoLine } from '@/server/demo/demo-line'
import { DEMO_GROUP_ID, DemoWorld } from '@/server/demo/world'
import { LinePushRejected } from '@/server/log'

function setup() {
  const world = new DemoWorld()
  world.group.botInGroup = true
  return { world, line: new DemoLine(world) }
}

describe('DemoLine', () => {
  it('records a reply as bot chat items, and refuses a reused reply token', async () => {
    const { world, line } = setup()
    await line.reply('rt1', [{ type: 'text', text: 'สวัสดี' }, { type: 'text', text: 'สอง' }])
    expect(world.chat.map((c) => [c.from, c.via, c.message])).toEqual([
      ['bot', 'reply', { type: 'text', text: 'สวัสดี' }],
      ['bot', 'reply', { type: 'text', text: 'สอง' }],
    ])
    await expect(line.reply('rt1', [{ type: 'text', text: 'again' }])).rejects.toThrow()
    expect(world.log.some((l) => l.kind === 'reply')).toBe(true)
  })

  it('records a push, charges one per member, and answers a repeated retry key as duplicate', async () => {
    const { world, line } = setup()
    expect(await line.push(DEMO_GROUP_ID, [{ type: 'text', text: 'เตือน' }], { retryKey: 'k1' })).toBe('sent')
    expect(world.quota.used).toBe(4)
    expect(world.chat[0]).toMatchObject({ from: 'bot', via: 'push', message: { type: 'text', text: 'เตือน' } })
    expect(await line.push(DEMO_GROUP_ID, [{ type: 'text', text: 'เตือน' }], { retryKey: 'k1' })).toBe('duplicate')
    expect(world.quota.used).toBe(4)
    expect(world.chat).toHaveLength(1)
  })

  it('refuses a push past the quota', async () => {
    const { world, line } = setup()
    world.quota = { limit: 5, used: 3 }
    await expect(line.push(DEMO_GROUP_ID, [{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(LinePushRejected)
    expect(world.chat).toHaveLength(0)
    expect(await line.getMessageQuota()).toEqual({ limit: 5, used: 3 })
  })

  it('serves profiles, member count, the group name and demo ID tokens of known personas only', async () => {
    const { world, line } = setup()
    const nont = world.persona('nont')!
    expect(await line.getGroupMemberProfile(DEMO_GROUP_ID, nont.lineUserId)).toEqual({ displayName: 'Nont' })
    expect(await line.getGroupMemberProfile(DEMO_GROUP_ID, 'Unobody')).toBeNull()
    expect(await line.getGroupMemberCount(DEMO_GROUP_ID)).toBe(4)
    expect(await line.getGroupSummary(DEMO_GROUP_ID)).toEqual({ groupName: 'ทีมพิตช์ NongJoDII' })
    expect(await line.verifyIdToken(`demo:${nont.lineUserId}`)).toEqual({ lineUserId: nont.lineUserId, displayName: 'Nont' })
    expect(await line.verifyIdToken('demo:Uunknown')).toBeNull()
    expect(await line.verifyIdToken(nont.lineUserId)).toBeNull()
  })

  it('serves uploaded content and leaves the group with a system line', async () => {
    const { world, line } = setup()
    world.contents.set('m1', { data: new Uint8Array([1, 2, 3]), contentType: 'image/png', fileName: 'a.png' })
    expect(await line.getMessageContent('m1', { timeoutMs: 1000, maxBytes: 10 })).toEqual({ data: new Uint8Array([1, 2, 3]), contentType: 'image/png' })
    expect(await line.getMessageContent('m2', { timeoutMs: 1000, maxBytes: 10 })).toBeNull()
    await expect(line.getMessageContent('m1', { timeoutMs: 1000, maxBytes: 2 })).rejects.toThrow()
    expect(await line.leaveGroup(DEMO_GROUP_ID)).toBe('left')
    expect(world.group.botInGroup).toBe(false)
    expect(world.chat.at(-1)).toMatchObject({ from: 'system', message: { type: 'system' } })
    expect(await line.leaveGroup(DEMO_GROUP_ID)).toBe('not_in_group')
  })

  it('routes pushes and replies to their own group: cost per that group, unread in the other', async () => {
    const { world, line } = setup()
    const dev = world.addGroup({ name: 'ทีม Dev', members: ['nont', 'tae'], botInGroup: true })
    world.replyTokens.set('rt-dev', dev.lineGroupId)
    expect(await line.push(dev.lineGroupId, [{ type: 'text', text: 'เตือนงาน' }])).toBe('sent')
    await line.reply('rt-dev', [{ type: 'text', text: 'ตอบใน Dev' }])
    expect(dev.chat.map((c) => [c.via, c.message])).toEqual([
      ['push', { type: 'text', text: 'เตือนงาน' }],
      ['reply', { type: 'text', text: 'ตอบใน Dev' }],
    ])
    expect(world.quota.used).toBe(2)
    expect(world.chat).toHaveLength(0)
    expect(world.unread(dev)).toBe(2)
    expect(await line.getGroupMemberCount(dev.lineGroupId)).toBe(2)
    expect(await line.getGroupMemberProfile(dev.lineGroupId, world.persona('bomb')!.lineUserId)).toBeNull()
    expect(await line.getGroupSummary(dev.lineGroupId)).toEqual({ groupName: 'ทีม Dev' })
  })
})
