import { execFileSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { OpenRouterClient } from '@/server/llm/openrouter'
import { OpenRouterDecisionsClient } from '@/server/llm/openrouter-decisions'
import type { DecisionsPort, Defer, Deps, LlmPort } from '@/server/ports'
import { SupabaseStore } from '@/server/store/supabase-store'
import { FakeDecisions } from '../test/fakes/fake-decisions'
import { FakeGoogle } from '../test/fakes/fake-google'
import { FakeLine } from '../test/fakes/fake-line'
import { FakeLlm } from '../test/fakes/fake-llm'
import { TEST_KEY, TEST_LIFF_ID, TEST_SECRET, TEST_TICK_SECRET } from '../test/harness'

const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:54321'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

/** The local stack's secret key, read from `supabase status` so no key lives in the repo.
 *  E2E_SUPABASE_SECRET_KEY overrides it. */
function localSecretKey(): string {
  const fromEnv = process.env.E2E_SUPABASE_SECRET_KEY
  if (fromEnv) return fromEnv
  let out: string
  try {
    out = execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error('e2e needs a local Supabase stack: run `supabase start`, or set E2E_SUPABASE_SECRET_KEY')
  }
  const key = /^SECRET_KEY="?([^"\n]+)"?$/m.exec(out)?.[1] ?? /^SERVICE_ROLE_KEY="?([^"\n]+)"?$/m.exec(out)?.[1]
  if (!key) throw new Error('`supabase status -o env` printed no SECRET_KEY or SERVICE_ROLE_KEY')
  return key
}

/** Throws unless the URL points at this machine. The suite writes and deletes rows, so it must
 *  never reach a hosted database. */
export function assertLocalSupabaseUrl(url: string): void {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error(`E2E_SUPABASE_URL is not a valid URL: ${url}`)
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`e2e refuses to run against host "${host}": only 127.0.0.1 or localhost (a local Supabase stack)`)
  }
}

export type E2eDeps = {
  deps: Deps
  line: FakeLine
  /** The model port the handlers use: FakeLlm, or OpenRouter when E2E_REAL_LLM=1. */
  llm: LlmPort
  /** The fake model, to queue answers on; null in real mode. */
  fakeLlm: FakeLlm | null
  /** The decision model port (progress): FakeDecisions, or OpenRouter when E2E_REAL_LLM=1. */
  decisions: DecisionsPort
  /** The fake decision model; null in real mode. */
  fakeDecisions: FakeDecisions | null
  google: FakeGoogle
  /** Raw supabase-js client, for seeding, cleanup and assertions. */
  db: SupabaseClient
  setNow(d: Date): void
  defer: Defer
  runDeferred(): Promise<void>
}

/** The composition of the webhook for a scenario: the real SupabaseStore on local Supabase,
 *  fakes for LINE and Google, and the model (fake by default). The clock and config follow
 *  makeTestDeps in test/harness.ts. */
export function makeE2eDeps(opts: { now: Date }): E2eDeps {
  const url = process.env.E2E_SUPABASE_URL ?? DEFAULT_SUPABASE_URL
  assertLocalSupabaseUrl(url)
  const key = localSecretKey()
  // Same options as src/server/deps.ts. Real fetch is used (no test/setup.ts here).
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const store = new SupabaseStore(db)

  let llm: LlmPort
  let fakeLlm: FakeLlm | null = null
  let decisions: DecisionsPort
  let fakeDecisions: FakeDecisions | null = null
  if (process.env.E2E_REAL_LLM === '1') {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('E2E_REAL_LLM=1 needs OPENROUTER_API_KEY in the environment')
    llm = new OpenRouterClient({ apiKey })
    decisions = new OpenRouterDecisionsClient({ apiKey })
  } else {
    fakeLlm = new FakeLlm()
    llm = fakeLlm
    fakeDecisions = new FakeDecisions()
    decisions = fakeDecisions
  }

  const line = new FakeLine()
  const google = new FakeGoogle()
  let current = new Date(opts.now.getTime())
  const clock = {
    now: () => new Date(current.getTime()),
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms)
    },
  }
  google.clock = clock
  line.clock = clock

  const deferred: Array<() => Promise<void>> = []
  const deps: Deps = {
    line, llm, decisions, google, store,
    now: () => new Date(current.getTime()),
    // Like the harness: a wait moves the clock instead of sleeping.
    sleep: async (ms) => {
      clock.advance(ms)
    },
    config: { lineChannelSecret: TEST_SECRET, liffId: TEST_LIFF_ID, tokenEncryptionKey: TEST_KEY, tickSecret: TEST_TICK_SECRET },
  }

  return {
    deps, line, llm, fakeLlm, decisions, fakeDecisions, google, db,
    setNow(d: Date) {
      current = new Date(d.getTime())
    },
    defer: (job) => {
      deferred.push(job)
    },
    /** Runs queued jobs in order, including the jobs they queue, until none are left. */
    async runDeferred() {
      while (deferred.length > 0) {
        const job = deferred.shift() as () => Promise<void>
        await job()
      }
    },
  }
}
