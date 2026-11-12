import { defineConfig } from 'vitest/config'

// Tests run in Node through the event seam and fakes (LINE, OpenRouter, Google, Supabase), so no browser DOM.
export default defineConfig({
  // Use the "@/*" alias from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // Same time zone as the real server (UTC). Bangkok time is always computed in code.
    env: { TZ: 'UTC' },
  },
})
