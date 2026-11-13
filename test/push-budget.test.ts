import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type GroupPush, pushToGroupWithinBudget, retryKeyFrom } from '@/server/line/push-budget'
import { makeTestDeps } from './harness'

// pushToGroupWithinBudget, the shared group push (#25): LINE pushes, push_log rows and the
// log lines come out. A repeat of an accepted retry key sends nothing (LINE answers 409),
// so its claim goes back while the accepted push keeps its own.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** The JSON log lines written through `fn` (console.info or console.error). */
function logged(fn: typeof console.info): Record<string, unknown>[] {
  return vi.mocked(fn).mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
}

function setup() {
  const h = makeTestDeps()
  const group = h.store.seedGroup({ lineGroupId: 'Cgroup1' })
  h.line.groupMemberCounts.set('Cgroup1', 4)
  const push = (p: Partial<GroupPush> = {}) => pushToGroupWithinBudget(h.deps, {
    purpose: 'setup_done', groupId: group.id, lineGroupId: 'Cgroup1',
    messages: [{ type: 'text', text: 'x' }], reserve: 0.02, retryKey: retryKeyFrom('card-1'), ...p,
  })
  return { ...h, group, push }
}

describe('pushToGroupWithinBudget', () => {
  it('a push LINE accepts keeps its claim', async () => {
    const t = setup()
    expect(await t.push()).toBe('pushed')
    expect(t.line.delivered).toHaveLength(1)
    expect(t.store.tables.push_log).toEqual([
      expect.objectContaining({ purpose: 'setup_done', lineTargetId: 'Cgroup1', messageCount: 4 }),
    ])
  })

  it('a repeat of an accepted retry key answers pushed, sends nothing and gives its claim back', async () => {
    const t = setup()
    await t.push()
    const first = t.store.tables.push_log.map((r) => r.id)
    expect(await t.push()).toBe('pushed')
    expect(t.line.pushes).toHaveLength(2)
    expect(t.line.delivered).toHaveLength(1)
    expect(t.store.tables.push_log.map((r) => r.id)).toEqual(first)
    // IDs only in the log line.
    expect(logged(console.info)).toContainEqual({ event: 'group_push_duplicate', purpose: 'setup_done', groupId: t.group.id })
  })

  it('a new retry key is a new post with its own claim', async () => {
    const t = setup()
    await t.push()
    expect(await t.push({ retryKey: retryKeyFrom('card-2') })).toBe('pushed')
    expect(t.line.delivered).toHaveLength(2)
    expect(t.store.tables.push_log).toHaveLength(2)
  })

  it('a duplicate whose release fails is logged and still answers pushed', async () => {
    const t = setup()
    await t.push()
    t.store.failNext('releasePushBudget')
    expect(await t.push()).toBe('pushed')
    // The extra claim stays; claim_push_budget stops counting it after 10 minutes.
    expect(t.store.tables.push_log).toHaveLength(2)
    expect(logged(console.error).map((l) => l.event)).toContain('group_push_budget_release_failed')
  })
})
