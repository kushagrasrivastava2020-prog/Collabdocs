import { defineConfig } from '@playwright/test'

/**
 * E2E against the real stack (Express + WebSocket server + Vite client).
 * - CI: starts `npm run dev` with an in-memory database and uses Playwright's Chromium.
 * - Locally: reuses a running dev server; set PW_CHANNEL=msedge (or chrome) to use an
 *   installed browser instead of downloading one.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        cwd: '..',
        // Proxied through Vite to the API: only healthy once both processes are up.
        url: 'http://localhost:5173/api/health',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { PGLITE_DIR: 'memory://', LOG_LEVEL: 'silent' },
      },
})
