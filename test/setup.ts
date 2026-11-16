import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { FALLBACK_GROUPS } from '@/server/demo/group-files'

// Real services are never called in tests: any code path that reaches the
// global fetch fails loudly. Adapters take an injected fetchImpl instead.
globalThis.fetch = (() => {
  throw new Error('Real network call in a test. Inject a fake port or fetchImpl.')
}) as typeof fetch

// The /demo seed reads src/app/demo/groups/ on every reset, and "สร้างกลุ่ม" writes there.
// Tests read a private folder with the three seed groups (the built-in definitions, which
// test/demo/groups.test.ts checks against the shipped files) instead, so groups a presenter
// added or deleted on the dev server never change a test, and no test writes into the repo.
const groupsCopy = mkdtempSync(path.join(tmpdir(), 'demo-groups-'))
for (const { file, def } of FALLBACK_GROUPS) writeFileSync(path.join(groupsCopy, file), JSON.stringify(def))
process.env.DEMO_GROUPS_DIR = groupsCopy
afterAll(() => rmSync(groupsCopy, { recursive: true, force: true }))
