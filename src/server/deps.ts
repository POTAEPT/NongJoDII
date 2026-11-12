import { createClient } from '@supabase/supabase-js'
import { loadConfig } from './config'
import { LineHttpClient } from './line/client'
import type { Deps, GooglePort, LlmPort } from './ports'
import { SupabaseStore } from './store/supabase-store'

// Composition root. Built lazily on the first call inside a handler (never at
// module top level), so `next build` needs no env. No test imports this file.

function notWired(): never {
  throw new Error('not wired yet')
}

// TEMP: Task 4 (OpenRouter) and Task 6 (Google) replace these stubs.
const llmStub: LlmPort = { complete: async () => notWired() }
const googleStub: GooglePort = { buildAuthUrl: () => notWired(), exchangeCode: async () => notWired() }

let cached: Deps | null = null

export function getDeps(): Deps {
  if (cached) return cached
  const config = loadConfig(process.env)
  cached = {
    line: new LineHttpClient({
      channelAccessToken: config.lineChannelAccessToken,
      loginChannelId: config.lineLoginChannelId,
    }),
    llm: llmStub,
    google: googleStub,
    store: new SupabaseStore(
      createClient(config.supabaseUrl, config.supabaseSecretKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    ),
    now: () => new Date(),
    config: {
      lineChannelSecret: config.lineChannelSecret,
      liffId: config.liffId,
      tokenEncryptionKey: config.tokenEncryptionKey,
    },
  }
  return cached
}
