import { defineConfig } from 'vitest/config'

// End-to-end scenarios: scripted group chats through the real webhook code, the real
// database adapter on a LOCAL Supabase stack, and fakes for LINE, the model and Google.
// Not part of `npm test`. Runs in series: every scenario cleans and reseeds the same rows.
export default defineConfig({
  // Use the "@/*" alias from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['e2e/**/*.e2e.test.ts'],
    // Real fetch is needed for supabase-js, so test/setup.ts (which blocks fetch) is not loaded.
    env: { TZ: 'UTC' },
    fileParallelism: false,
    testTimeout: 120_000,
  },
})
