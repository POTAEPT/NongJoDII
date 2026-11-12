import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleTickRequest } from '@/server/tick/handle-request'
import type { TickJob } from '@/server/tick/run-tick'
import { makeTestDeps, tickRequest } from './harness'

function setup(jobs: TickJob[] = []) {
  const h = makeTestDeps()
  const send = (opts?: Parameters<typeof tickRequest>[0]) => handleTickRequest(tickRequest(opts), h.deps, h.defer, jobs)
  return { ...h, send }
}

/** A job that records the instant it was given. */
function recorder(name: string, seen: Array<{ name: string; now: Date }>): TickJob {
  return { name, run: async (_deps, now) => { seen.push({ name, now }) } }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('tick route', () => {
  it('rejects a wrong secret and runs nothing', async () => {
    const seen: Array<{ name: string; now: Date }> = []
    const { send, deferred } = setup([recorder('a', seen)])
    const res = await send({ secret: 'wrong' })
    expect(res.status).toBe(401)
    expect(deferred).toHaveLength(0)
  })

  it('rejects a missing secret header and runs nothing', async () => {
    const { send, deferred } = setup()
    expect((await send({ secret: null })).status).toBe(401)
    expect((await send({ secret: '' })).status).toBe(401)
    expect(deferred).toHaveLength(0)
  })

  it('answers 200 before any job runs, then runs the jobs after the response', async () => {
    const seen: Array<{ name: string; now: Date }> = []
    const { send, deferred, runDeferred } = setup([recorder('a', seen)])
    const res = await send()
    expect(res.status).toBe(200)
    expect(seen).toHaveLength(0)
    expect(deferred).toHaveLength(1)
    await runDeferred()
    expect(seen.map((s) => s.name)).toEqual(['a'])
  })

  it('runs every job in order with the same instant', async () => {
    const seen: Array<{ name: string; now: Date }> = []
    const { send, runDeferred, setNow } = setup([recorder('a', seen), recorder('b', seen)])
    setNow(new Date('2026-11-16T02:00:00Z'))
    await send()
    await runDeferred()
    expect(seen.map((s) => s.name)).toEqual(['a', 'b'])
    expect(seen[0].now.toISOString()).toBe('2026-11-16T02:00:00.000Z')
    expect(seen[1].now.toISOString()).toBe('2026-11-16T02:00:00.000Z')
  })

  it('keeps going when one job fails, and logs only the job name', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const seen: Array<{ name: string; now: Date }> = []
    const failing: TickJob = { name: 'broken', run: async () => { throw new Error('secret detail from chat') } }
    const { send, runDeferred } = setup([failing, recorder('after', seen)])
    await send()
    await runDeferred()
    expect(seen.map((s) => s.name)).toEqual(['after'])
    expect(errors).toHaveBeenCalledTimes(1)
    const line = String(errors.mock.calls[0][0])
    expect(JSON.parse(line)).toMatchObject({ event: 'tick_job_failed', job: 'broken', error: 'Error' })
    expect(line).not.toContain('secret detail')
  })

  it('runs with no jobs registered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const { send, runDeferred } = setup([])
    expect((await send()).status).toBe(200)
    await expect(runDeferred()).resolves.toBeUndefined()
  })
})
