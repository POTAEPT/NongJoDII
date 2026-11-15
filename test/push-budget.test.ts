import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type GroupPush, pushToGroupWithinBudget, retryKeyFrom } from '@/server/line/push-budget'
import { makeTestDeps } from './harness'

// pushToGroupWithinBudget, the shared group push (#25): LINE pushes, push_log rows and the
// log lines come out. A repeat of an accepted retry key sends nothing (LINE answers 409),
// so its claim goes back while the accepted push keeps its own. A failed push gives its
// claim back only when LINE refused it (a 4xx); after a 5xx or a timeout LINE may have
// delivered it, so the claim stays.

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

  it('a push LINE accepted but whose answer timed out keeps its claim; the resend gives back only its own', async () => {
    const t = setup()
    t.line.timeoutAfterAccept = true
    expect(await t.push()).toBe('failed')
    t.line.timeoutAfterAccept = false
    // The card is in the group, and its claim still books it.
    expect(t.line.delivered).toHaveLength(1)
    expect(t.store.tables.push_log).toHaveLength(1)
    const first = t.store.tables.push_log.map((r) => r.id)
    expect(logged(console.error)).toContainEqual({ event: 'group_push_failed', purpose: 'setup_done', groupId: t.group.id, error: 'line timeout' })
    // IDs only in the log line.
    expect(logged(console.info)).toContainEqual({ event: 'group_push_outcome_unknown', purpose: 'setup_done', groupId: t.group.id })

    // An immediate resend under the same key: LINE answers 409 and sends nothing.
    expect(await t.push()).toBe('pushed')
    expect(t.line.pushes).toHaveLength(2)
    expect(t.line.delivered).toHaveLength(1)
    expect(t.store.tables.push_log.map((r) => r.id)).toEqual(first)
  })

  it('a push LINE refuses (4xx) gives its claim back', async () => {
    const t = setup()
    t.line.rejectPush = true
    expect(await t.push()).toBe('failed')
    expect(t.line.pushes).toHaveLength(1)
    expect(t.line.delivered).toHaveLength(0)
    expect(t.store.tables.push_log).toHaveLength(0)
    expect(logged(console.error)).toContainEqual({ event: 'group_push_failed', purpose: 'setup_done', groupId: t.group.id, error: 'line push 400' })
    expect(logged(console.info).map((l) => l.event)).not.toContain('group_push_outcome_unknown')
  })

  it('a refused push whose release fails is logged and still answers failed', async () => {
    const t = setup()
    t.line.rejectPush = true
    t.store.failNext('releasePushBudget')
    expect(await t.push()).toBe('failed')
    expect(t.store.tables.push_log).toHaveLength(1)
    expect(logged(console.error).map((l) => l.event)).toContain('group_push_budget_release_failed')
  })

  it('a push with an unknown outcome that LINE did not deliver keeps its claim, and the resend adds its own', async () => {
    const t = setup()
    t.line.failPush = true // a LINE 5xx: not accepted, but the caller cannot know
    expect(await t.push()).toBe('failed')
    t.line.failPush = false
    expect(t.line.delivered).toHaveLength(0)
    expect(t.store.tables.push_log).toHaveLength(1)
    expect(logged(console.info)).toContainEqual({ event: 'group_push_outcome_unknown', purpose: 'setup_done', groupId: t.group.id })

    // The key was never accepted, so the resend is a real push with its own claim. The
    // first claim now books messages that were never sent: a known overcount, which errs
    // toward skipping and ends when claim_push_budget stops counting the row (10 minutes).
    expect(await t.push()).toBe('pushed')
    expect(t.line.delivered).toHaveLength(1)
    expect(t.store.tables.push_log).toHaveLength(2)
  })

  it('a failure before the push claims nothing and logs no unknown outcome', async () => {
    const t = setup()
    t.line.failQuota = true
    expect(await t.push()).toBe('failed')
    expect(t.line.pushes).toHaveLength(0)
    expect(t.store.tables.push_log).toHaveLength(0)
    expect(logged(console.info).map((l) => l.event)).not.toContain('group_push_outcome_unknown')
  })
})
