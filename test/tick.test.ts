import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { TickJob } from '@/server/tick/run-tick'
import { makeTestDeps, tickRequest } from './harness'

function setup(jobs: TickJob[] = []) {
  const h = makeTestDeps()
  const send = (opts?: Parameters<typeof tickRequest>[0]) => handleTickRequest(tickRequest(opts), h.deps, h.defer, jobs)
  return { ...h, send }
}

/** A job that pushes one text to a group, naming itself and the instant it was given.
 *  Tests read what the tick did from the pushes the fake LINE received. */
function pusher(name: string, groupId = 'Cgroup1'): TickJob {
  return {
    name,
    run: async (deps, now) => {
      await deps.line.push(groupId, [{ type: 'text', text: `${name} ${now.toISOString()}` }])
    },
  }
}

const pushedTexts = (pushes: { messages: { type: string; text?: string }[] }[]) =>
  pushes.map((p) => (p.messages[0].type === 'text' ? p.messages[0].text : ''))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tick route', () => {
  it('rejects a wrong secret and sends nothing', async () => {
    const { send, deferred, runDeferred, line } = setup([pusher('a')])
    const res = await send({ secret: 'wrong' })
    expect(res.status).toBe(401)
    expect(deferred).toHaveLength(0)
    await runDeferred()
    expect(line.pushes).toHaveLength(0)
  })

  it('rejects a missing or empty secret header and sends nothing', async () => {
    const { send, deferred, runDeferred, line } = setup([pusher('a')])
    expect((await send({ secret: null })).status).toBe(401)
    expect((await send({ secret: '' })).status).toBe(401)
    expect(deferred).toHaveLength(0)
    await runDeferred()
    expect(line.pushes).toHaveLength(0)
  })

  it('answers 200 before anything is pushed, then pushes after the response', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { send, runDeferred, line } = setup([pusher('a')])
    const res = await send()
    expect(res.status).toBe(200)
    expect(line.pushes).toHaveLength(0)
    await runDeferred()
    expect(line.pushes).toHaveLength(1)
    expect(line.pushes[0].to).toBe('Cgroup1')
  })

  it('runs every job in order, all with the same instant', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { send, runDeferred, setNow, line } = setup([pusher('a'), pusher('b', 'Cgroup2')])
    setNow(new Date('2026-11-16T02:00:00Z'))
    await send()
    await runDeferred()
    expect(line.pushes.map((p) => p.to)).toEqual(['Cgroup1', 'Cgroup2'])
    expect(pushedTexts(line.pushes)).toEqual(['a 2026-11-16T02:00:00.000Z', 'b 2026-11-16T02:00:00.000Z'])
  })

  it('keeps going when one job fails, and logs only the job name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const failing: TickJob = { name: 'broken', run: async () => { throw new Error('secret detail from chat') } }
    const { send, runDeferred, line } = setup([failing, pusher('after')])
    await send()
    await runDeferred()
    expect(pushedTexts(line.pushes)).toEqual([expect.stringMatching(/^after /)])
    expect(errors).toHaveBeenCalledTimes(1)
    const logged = String(errors.mock.calls[0][0])
    expect(JSON.parse(logged)).toMatchObject({ event: 'tick_job_failed', job: 'broken', error: 'Error' })
    expect(logged).not.toContain('secret detail')
  })

  it('keeps going when a push fails inside a job', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { send, runDeferred, line } = setup([pusher('first'), pusher('second', 'Cgroup2')])
    line.failPush = true
    await send()
    await runDeferred()
    // Both pushes were attempted; the first failure did not stop the second job.
    expect(line.pushes.map((p) => p.to)).toEqual(['Cgroup1', 'Cgroup2'])
  })

  it('answers 200 and sends nothing when no jobs are registered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { send, runDeferred, line, store } = setup([])
    expect((await send()).status).toBe(200)
    await runDeferred()
    expect(line.pushes).toHaveLength(0)
    expect(store.tables.messages).toHaveLength(0)
  })
})
