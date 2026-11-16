import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LineMessage } from '@/server/line/types'
import type { ExpectedTask, Scenario } from './scenario-types'
import { runScenario, type ScenarioResult } from './run-scenario'

const REAL_LLM = process.env.E2E_REAL_LLM === '1'

function loadScenarios(): Scenario[] {
  const dir = new URL('./scenarios/', import.meta.url)
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Scenario)
}

function textOf(messages: LineMessage[]): string {
  return messages.map((m) => (m.type === 'text' ? m.text : '')).join('\n')
}

describe('e2e scenarios', () => {
  for (const scenario of loadScenarios()) {
    it(`${scenario.name}: ${scenario.feature}`, async () => {
      const result = await runScenario(scenario)
      if (REAL_LLM) checkReal(scenario, result)
      else checkFake(scenario, result)
    }, 120_000)
  }
})

/** Fake model: the exact expectations. */
function checkFake(s: Scenario, r: ScenarioResult): void {
  expect(r.builderErrors).toEqual([])
  expect(r.storedMessages).toBe(s.expect.storedMessages)
  expect(r.summaries).toHaveLength(s.expect.summaries)
  expect(r.candidates).toHaveLength(s.expect.candidates)
  expect(r.replyHasReviewButton).toBe(s.expect.replyHasReviewButton)
  expect(r.pushes).toBe(0)
  expect(r.commandReplies).toHaveLength(1)
  const [reply] = r.commandReplies

  if (s.expectedTasks.length === 0) {
    expect(reply).toHaveLength(1)
    expect(reply[0].type).toBe('text')
    expect(textOf(reply)).toContain('ไม่พบงานใหม่ในแชตช่วงนี้')
    return
  }

  s.expectedTasks.forEach((expected: ExpectedTask, i) => {
    const fakeTitle = s.fakeModelAnswer.tasks[i]?.title
    expect(fakeTitle, `fake answer task ${i}`).toBeDefined()
    const candidate = r.candidates.find((c) => c.title === fakeTitle)
    expect(candidate, `candidate titled ${fakeTitle}`).toBeDefined()
    if (!candidate) return
    expect(candidate.title).toBe(expected.title)
    expect(candidate.assigneeLineUserId).toBe(s.personas[expected.assignee].lineUserId)
    expect(candidate.dueAt?.getTime()).toBe(Date.parse(expected.due))
  })
}

/** Real model: counts only, then a side-by-side log for a human to read. */
function checkReal(s: Scenario, r: ScenarioResult): void {
  expect(r.summaries).toHaveLength(1)
  expect(r.candidates).toHaveLength(s.expectedTasks.length)
  const personaOf = (lineUserId: string | null): string => {
    const hit = Object.entries(s.personas).find(([, p]) => p.lineUserId === lineUserId)
    return hit ? hit[1].lineName : '-'
  }
  const rows = Math.max(s.expectedTasks.length, r.candidates.length)
  const table = Array.from({ length: rows }, (_, i) => {
    const e = s.expectedTasks[i]
    const a = r.candidates[i]
    return {
      expectedTitle: e?.title ?? '-',
      expectedAssignee: e ? s.personas[e.assignee].lineName : '-',
      expectedDue: e?.due ?? '-',
      actualTitle: a?.title ?? '-',
      actualAssignee: personaOf(a?.assigneeLineUserId ?? null),
      actualDue: a?.dueAt?.toISOString() ?? '-',
    }
  })
  console.log(`[${s.name}] expected vs actual (real model)`)
  console.table(table)
}
