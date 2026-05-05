import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT || 3005)
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${port}`

/**
 * Playwright config — minimal, CI-safe setup.
 *
 * We boot the Next.js dev server on port 3005 (not 3001, to avoid
 * clashing with the developer's primary dev session) and run smoke
 * tests against it. The webServer block handles lifecycle: Playwright
 * starts the server, waits for the port, runs the suite, and tears down.
 *
 * To run locally:
 *   npm run test:e2e
 *
 * The browsers are downloaded on demand:
 *   npx playwright install chromium
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],

  webServer: {
    command: `npm run dev -- --port ${port}`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
})
