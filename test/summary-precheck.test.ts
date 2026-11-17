import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionsResult, LlmRequest, LlmUsage } from '@/server/ports'
import { buildPrecheckRequest, COUNT_HINT, mapPrecheck } from '@/server/summary/precheck'
import { buildSummaryPrompt, COUNT_IS_PROJECT_WORK, PROJECT_WORK_ONLY } from '@/server/summary/prompt'
import { SUMMARY_TEXT } from '@/server/summary/reply'
import { SUMMARY_FAILED_TEXT } from '@/server/summary/failure'
import { mergeTasks, SUMMARY_BUDGET_MS } from '@/server/summary/run-summary'
import { DECISION_MODEL, TEXT_MODEL } from '@/server/usage/pricing'
import { handleWebhookRequest } from '@/server/webhook/handle-request'
import { refOf } from './fakes/prompt-reader'
import { ev, makeTestDeps, seedOwnedGroup, signedRequest, webhookBody } from './harness'

// #157: one TypeSafe Jev call reads the Summary's chat first: no work means the summary only
// (no Task candidates, no review button); a count means a hint, and a short first answer gets
// one retry. A Jev failure keeps the old single text call. At most 1 Jev and 2 text calls.

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const T0 = Date.UTC(2026, 10, 12, 2, 0, 0)
const MIN = 60_000
const USAGE: LlmUsage = { inputTokens: 1000, outputTokens: 200, costUsd: null }
const MEMBERS = [{ lineUserId: 'Upim', displayName: 'Pim' }, { lineUserId: 'Ubank', displayName: 'Bank' }]

function setup(opts: { draftTasks?: boolean } = {}) {
  const h = makeTestDeps()
  const group = seedOwnedGroup(h.store, { members: MEMBERS })
  if (opts.draftTasks === false) h.store.tables.groups.find((g) => g.id === group.id)!.featureDraftTasks = false
  const send = async (...events: Parameters<typeof webhookBody>) => {
    const res = await handleWebhookRequest(signedRequest(webhookBody(...events)), h.deps, h.defer)
    expect(res.status).toBe(200)
    await h.runDeferred()
  }
  /** Chat lines with no progress word, so only the Summary reaches the models. */
  const chat = () => send(
    ev.groupText({ text: 'ต้องมีสไลด์ รายงาน และโปสเตอร์ ส่งศุกร์', userId: 'Ubank', timestamp: T0 }),
    ev.groupText({ text: 'โอเค แบ่งกันนะ', userId: 'Upim', timestamp: T0 + MIN }),
  )
  const summarize = () => send(ev.groupText({ text: 'NongJoDII summarize', userId: 'Upim', replyToken: 'rt-cmd', timestamp: T0 + 5 * MIN }))
  /** Moves the test clock, as if a call took `ms`. */
  const takes = (ms: number) => h.setNow(new Date(h.deps.now().getTime() + ms))
  /** A text answer; `takesMs` moves the test clock as if the call took that long. Each title
   *  may carry a source ref as `title@msgN`. */
  const answer = (titles: string[], takesMs = 0) => h.llm.respond(async () => {
    takes(takesMs)
    return {
      content: JSON.stringify({
        summary: 'คุยเรื่องงาน',
        tasks: titles.map((t) => {
          const [title, source] = t.split('@')
          return { title, details: null, assignee: null, due: null, source: source ?? null, tags: [] }
        }),
      }),
      model: TEXT_MODEL, usage: USAGE,
    }
  })
  const jev = (hasTask: number, count: string | null): DecisionsResult => ({
    model: DECISION_MODEL,
    answers: {
      has_task: { type: 'noul', noul: hasTask, confidence: 0.9 },
      task_count: count === null ? null : { type: 'choice', choice: count, probabilities: { [count]: 0.9 }, confidence: 0.9 },
    },
    usage: { inputTokens: 300, outputTokens: 0, costUsd: null },
  })
  const replyText = () => JSON.stringify(h.line.replies.find((r) => r.replyToken === 'rt-cmd')?.messages ?? [])
  const userOf = (i: number) => (h.llm.requests[i] as LlmRequest).user
  /** A model answer the Summary parser cannot read. */
  const unreadable = () => h.llm.respond(() => ({ content: 'not json {', model: TEXT_MODEL, usage: USAGE }))
  return { ...h, send, takes, chat, summarize, answer, jev, replyText, userOf, unreadable }
}

describe('the Summary pre-check (#157)', () => {
  it('no work in the chat: the summary only, no candidates and no review button, one text call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.1, null))
    s.answer(['งานที่ไม่ควรมี'])
    await s.summarize()
    expect(s.decisions.requests).toHaveLength(1)
    expect(s.llm.requests).toHaveLength(1)
    expect(s.userOf(0)).toContain('found no work')
    expect(s.store.tables.task_candidates).toEqual([])
    expect(s.replyText()).toContain(SUMMARY_TEXT.none)
    expect(s.replyText()).not.toContain('view=review')
  })

  it('a count goes to the text model as a hint; enough Tasks means no retry', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'ทำโปสเตอร์'])
    await s.summarize()
    expect(s.userOf(0)).toContain(COUNT_HINT.several)
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a short first answer gets one retry, which names what the first one listed', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์'])
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'ทำโปสเตอร์'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.userOf(1)).toContain('Your first answer listed 1 task(s)')
    expect(s.userOf(1)).toContain('- ทำสไลด์')
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a retry still short keeps the first answer\'s Tasks and says there may be more; never a third call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน'])
    s.answer(['ทำสไลด์'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.store.tables.task_candidates).toHaveLength(2)
    expect(s.replyText()).toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('the retry merges: the first answer\'s Tasks stay and only new ones are added, without duplicates', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.answer(['ทำสไลด์', 'Write  Report'])
    // A shorter retry that drops "ทำสไลด์", repeats the report (other spacing and case) and adds the poster.
    s.answer(['  write report ', 'ทำโปสเตอร์'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.userOf(1)).toContain('Keep the tasks above and add any missing ones')
    expect(s.store.tables.task_candidates.map((c) => c.title)).toEqual(['ทำสไลด์', 'Write  Report', 'ทำโปสเตอร์'])
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('"many" with 3 Tasks is enough: no retry and no "may have more" line (Jev calls a 3-Task chat "many")', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.answer(['ทำสไลด์', 'เขียนรายงาน', 'จองห้องซ้อม'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.task_candidates).toHaveLength(3)
    expect(s.replyText()).not.toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('an unreadable answer to the hinted prompt: the second call is the old prompt, and no third call', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'many'))
    s.unreadable()
    s.answer(['ทำสไลด์', 'เขียนรายงาน'])
    await s.summarize()
    expect(s.llm.requests).toHaveLength(2)
    expect(s.userOf(0)).toContain('A first reading found')
    expect(s.userOf(1)).not.toContain('A first reading found')
    expect(s.store.tables.task_candidates).toHaveLength(2)
  })

  it('an unreadable answer with no hint fails as before (one call)', async () => {
    const s = setup()
    await s.chat()
    s.decisions.fail(new Error('down'))
    s.unreadable()
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.summaries).toEqual([])
  })

  it('a failed retry keeps the first answer', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'several'))
    s.answer(['ทำสไลด์'])
    s.llm.fail(new Error('timeout'))
    await s.summarize()
    expect(s.store.tables.task_candidates).toHaveLength(1)
    expect(s.replyText()).toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('a Jev failure or refusal keeps the old single text call, with no hint', async () => {
    for (const fail of [true, false]) {
      const s = setup()
      await s.chat()
      if (fail) s.decisions.fail(new Error('alpha api down'))
      else s.decisions.respond({ model: DECISION_MODEL, answers: { has_task: null, task_count: null }, usage: null })
      s.answer(['ทำสไลด์'])
      await s.summarize()
      expect(s.llm.requests).toHaveLength(1)
      expect(s.userOf(0)).not.toContain('A first reading found')
      expect(s.store.tables.task_candidates).toHaveLength(1)
    }
  })

  it('with Draft tasks off there is no Jev call', async () => {
    const s = setup({ draftTasks: false })
    await s.chat()
    s.answer([])
    await s.summarize()
    expect(s.decisions.requests).toHaveLength(0)
    expect(s.llm.requests).toHaveLength(1)
  })

  it('both calls are metered against the Owner', async () => {
    const s = setup()
    await s.chat()
    s.decisions.respond(s.jev(0.9, 'one'))
    s.answer(['ทำสไลด์'])
    await s.summarize()
    expect(s.store.tables.ai_usage.map((u) => u.model).sort()).toEqual([DECISION_MODEL, TEXT_MODEL].sort())
  })
})

describe('the Summary time budget (#157)', () => {
  const SEC = 1000
  /** A Jev answer that takes `ms` on the test clock. */
  const slowJev = (s: ReturnType<typeof setup>, result: DecisionsResult, ms: number) =>
    s.decisions.respond(async () => {
      s.takes(ms)
      return result
    })
  /** Store work before the AI calls takes `ms` on the test clock. */
  const slowStore = (s: ReturnType<typeof setup>, ms: number) => {
    const original = s.store.getGroupSetup.bind(s.store)
    vi.spyOn(s.store, 'getGroupSetup').mockImplementation(async (groupId) => {
      s.takes(ms)
      return original(groupId)
    })
  }

  it('each call gets min(its own cap, time left), so the budget shrinks from call to call', async () => {
    const s = setup()
    await s.chat()
    slowJev(s, s.jev(0.9, 'several'), 10 * SEC)
    s.answer(['ทำสไลด์'], 20 * SEC)
    s.answer(['ทำสไลด์', 'เขียนรายงาน'])
    await s.summarize()
    expect(s.decisions.requests[0].timeoutMs).toBe(15 * SEC)
    expect(s.llm.requests.map((r) => r.timeoutMs)).toEqual([40 * SEC, 20 * SEC])
    expect(SUMMARY_BUDGET_MS).toBe(50 * SEC)
  })

  it('no retry when less than 15 s is left: the first answer stays and the "may have more" line shows', async () => {
    const s = setup()
    await s.chat()
    slowJev(s, s.jev(0.9, 'several'), 10 * SEC)
    s.answer(['ทำสไลด์'], 26 * SEC)
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.task_candidates).toHaveLength(1)
    expect(s.replyText()).toContain(SUMMARY_TEXT.mayHaveMore)
  })

  it('no plain-prompt second call when less than 15 s is left: the unreadable answer fails as before', async () => {
    const s = setup()
    await s.chat()
    slowJev(s, s.jev(0.9, 'many'), 10 * SEC)
    s.llm.respond(async () => {
      s.takes(30 * SEC)
      return { content: 'not json {', model: TEXT_MODEL, usage: USAGE }
    })
    await s.summarize()
    expect(s.llm.requests).toHaveLength(1)
    expect(s.store.tables.summaries).toEqual([])
    expect(s.replyText()).toContain(SUMMARY_FAILED_TEXT.ai_output)
  })

  it('no pre-check when less than 30 s is left: the old single text call, within the time left', async () => {
    const s = setup()
    await s.chat()
    slowStore(s, 25 * SEC)
    s.answer(['ทำสไลด์'])
    await s.summarize()
    expect(s.decisions.requests).toHaveLength(0)
    expect(s.llm.requests).toHaveLength(1)
    expect(s.llm.requests[0].timeoutMs).toBe(25 * SEC)
    expect(s.userOf(0)).not.toContain('A first reading found')
    expect(s.store.tables.task_candidates).toHaveLength(1)
  })

  it('a budget spent before the first text call takes the timeout failure path, with no text call', async () => {
    const s = setup()
    await s.chat()
    slowStore(s, 50 * SEC)
    await s.summarize()
    expect(s.llm.requests).toHaveLength(0)
    expect(s.store.tables.summaries).toEqual([])
    expect(s.replyText()).toContain(SUMMARY_FAILED_TEXT.ai_timeout)
  })
})

describe('mergeTasks (#157)', () => {
  const task = (title: string, sourceRef: string | null = null) =>
    ({ title, details: null, assigneeRef: null, due: null, sourceRef, tags: [] })

  it('matches by normalised title, and by source message when both name one', () => {
    const first = [task('Make Slides', 'msg1'), task('write report')]
    const retry = [
      task(' make   slides ', 'msg1'), // same Task
      task('make slides', 'msg4'), // same title, another message: a separate Task
      task('Write Report', 'msg2'), // the first has no source: same Task
      task('book room'), task('Book  Room'), // new, once
    ]
    expect(mergeTasks(first, retry).map((t) => [t.title, t.sourceRef])).toEqual([
      ['Make Slides', 'msg1'], ['write report', null], ['make slides', 'msg4'], ['book room', null],
    ])
  })
})

describe('mapPrecheck and the request (#157)', () => {
  it('reads has_task against 0.5, and an unknown count as null', () => {
    expect(mapPrecheck({ has_task: { type: 'noul', noul: 0.49, confidence: null } })).toEqual({ hasTask: false })
    expect(mapPrecheck({ has_task: { type: 'noul', noul: 0.5, confidence: null }, task_count: null })).toEqual({ hasTask: true, count: null })
    expect(mapPrecheck({ has_task: null })).toBeNull()
  })

  it('asks Jev about the same chat lines the Summary reads', () => {
    const req = buildPrecheckRequest('msg1 [2026-11-12 09:00] m1: ทำสไลด์ด้วย')
    expect(req.model).toBe(DECISION_MODEL)
    expect(req.state).toContain('msg1 [2026-11-12 09:00] m1: ทำสไลด์ด้วย')
    expect(Object.keys(req.questions)).toEqual(['has_task', 'task_count'])
  })
})

describe('casual chat is not work, and a day with no time is due 23:59', () => {
  it('the pre-check criteria say snacks, drinks and jokes are not work, for both questions', () => {
    const req = buildPrecheckRequest('msg1 [2026-11-12 09:00] m1: 555 เดี๋ยวสั่งชานมด้วย')
    const hasTask = JSON.stringify(req.questions.has_task)
    const count = JSON.stringify(req.questions.task_count)
    for (const q of [hasTask, count]) {
      expect(q).toContain('snacks, drinks or food orders')
      expect(q).toContain('jokes or lines said for a laugh (such as a line with 555)')
    }
    expect(count).toContain('project or study work')
    expect(hasTask).toContain('book a meeting room')
  })

  it('the Summary prompt lists only project work as tasks, and asks for a date-only due', () => {
    const p = buildSummaryPrompt({
      now: new Date(T0), workDescription: 'โปรเจกต์วิชาการตลาด', members: [], messages: [],
      precheck: { noTask: false, countHint: COUNT_HINT.several },
    })
    expect(p.system).toContain(PROJECT_WORK_ONLY)
    expect(PROJECT_WORK_ONLY).toContain('ONLY work toward the group\'s project or study goals')
    expect(PROJECT_WORK_ONLY).toContain('never call such casual items unassigned')
    expect(p.user).toContain(COUNT_IS_PROJECT_WORK)
    expect(p.system).toContain('the date only, "YYYY-MM-DD" (the day ends at 23:59)')
  })

  // The live chat of 2026-11-17 (production, with the Jev pre-check). The prompt fixes the
  // real model; code never drops a Task by keyword, so the fake model's 4 Tasks all pass.
  it('the live chat: 4 Tasks pass through, and day-only and T00:00 dues become 23:59', async () => {
    const s = setup()
    await s.send(
      ev.groupText({ text: 'เราทำสไลด์พรีเซนต์ให้ ส่งวันศุกร์', userId: 'Upim', timestamp: T0 }),
      ev.groupText({ text: 'ผมทำรายงานให้ ส่งวันพฤหัส', userId: 'Ubank', timestamp: T0 + MIN }),
      ev.groupText({ text: 'อย่าลืมจองห้องประชุมด้วย', userId: 'Upim', timestamp: T0 + 2 * MIN }),
      ev.groupText({ text: '555 เดี๋ยวสั่งชานมด้วย', userId: 'Ubank', timestamp: T0 + 3 * MIN }),
    )
    s.decisions.respond(s.jev(0.9, 'several'))
    s.llm.respond((req: LlmRequest) => ({
      content: JSON.stringify({
        summary: 'แบ่งงานสไลด์และรายงาน',
        tasks: [
          { title: 'ทำสไลด์พรีเซนต์', details: null, assignee: refOf(req, 'Pim'), due: '2026-11-20', source: 'msg1', tags: [] },
          { title: 'จัดทำรายงาน', details: null, assignee: refOf(req, 'Bank'), due: '2026-11-19T00:00:00+07:00', source: 'msg2', tags: [] },
          { title: 'จองห้องประชุม', details: null, assignee: null, due: null, source: 'msg3', tags: [] },
          { title: 'สั่งชานม', details: null, assignee: null, due: null, source: 'msg4', tags: [] },
        ],
      }),
      model: TEXT_MODEL, usage: USAGE,
    }))
    await s.summarize()

    expect(JSON.stringify(s.decisions.requests[0].questions)).toContain('milk tea')
    expect(s.llm.requests).toHaveLength(1) // "several" needs 2: no retry
    expect(s.llm.requests[0].system).toContain(PROJECT_WORK_ONLY)
    expect(s.store.tables.task_candidates.map((c) => [c.title, c.suggestedAssigneeLineUserId, c.suggestedDueAt])).toEqual([
      ['ทำสไลด์พรีเซนต์', 'Upim', new Date('2026-11-20T23:59:00+07:00')],
      ['จัดทำรายงาน', 'Ubank', new Date('2026-11-19T23:59:00+07:00')],
      ['จองห้องประชุม', null, null],
      ['สั่งชานม', null, null],
    ])
    expect(s.replyText()).toContain('ศ. 20 พ.ย. 23:59')
    expect(s.replyText()).toContain('พฤ. 19 พ.ย. 23:59')
  })

  it('a T00:00 due stays 00:00 when its message says เที่ยงคืน', async () => {
    const s = setup()
    await s.send(ev.groupText({ text: 'ส่งรายงานวันพฤหัสตอนเที่ยงคืนนะ', userId: 'Ubank', timestamp: T0 }))
    s.decisions.respond(s.jev(0.9, 'one'))
    s.llm.respond(() => ({
      content: JSON.stringify({
        summary: 'ส่งรายงาน',
        tasks: [{ title: 'ส่งรายงาน', details: null, assignee: null, due: '2026-11-19T00:00:00+07:00', source: 'msg1', tags: [] }],
      }),
      model: TEXT_MODEL, usage: USAGE,
    }))
    await s.summarize()
    expect(s.store.tables.task_candidates[0].suggestedDueAt).toEqual(new Date('2026-11-19T00:00:00+07:00'))
  })
})
