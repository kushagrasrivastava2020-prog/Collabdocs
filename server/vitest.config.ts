import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Each test file boots its own in-memory database + server, so files can run in parallel.
    pool: 'forks',
  },
})
