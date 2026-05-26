import { expect, test } from "@playwright/test"
import path from "node:path"
import fs from "node:fs"

/**
 * Visual regression scaffold — screenshot COLLECTION ONLY.
 *
 * This spec does not perform any pixel-diff comparison. Real visual
 * regression needs dedicated infrastructure (Percy / Chromatic /
 * Playwright `toHaveScreenshot` with a baseline store + reviewer
 * workflow). Until that lands, we collect screenshots of the most
 * critical surfaces at desktop + mobile breakpoints on every CI run
 * so reviewers can eyeball them in the uploaded artifact and a future
 * job can wire up automated comparison without re-discovering which
 * pages matter.
 *
 * Output: test-results/screenshots/<page>-<viewport>.png
 *
 * Critical pages (5):
 *   1. /             — landing / locale redirect
 *   2. /login        — auth gate
 *   3. /register     — sign-up funnel
 *   4. /chat         — primary product surface
 *   5. /pricing      — conversion / billing
 *
 * Breakpoints (2):
 *   - desktop: 1440 × 900
 *   - mobile:  390  × 844 (iPhone-ish)
 */

const OUT_DIR = path.resolve(process.cwd(), "test-results", "screenshots")

const CRITICAL_PAGES: Array<{ name: string; path: string }> = [
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
  { name: "register", path: "/register" },
  { name: "chat", path: "/chat" },
  { name: "pricing", path: "/pricing" },
]

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
})

for (const vp of VIEWPORTS) {
  for (const pg of CRITICAL_PAGES) {
    test(`visual · ${pg.name} @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })

      // Soft navigation — some critical paths redirect (auth-gated /chat,
      // locale prefix on /). We accept any 2xx/3xx; the screenshot is what
      // matters, not the response code at this stage of the scaffold.
      const response = await page.goto(pg.path, { waitUntil: "domcontentloaded" })
      expect(response, `goto(${pg.path}) returned null`).not.toBeNull()

      // Give the client a moment to paint. We deliberately use a short
      // networkidle window — full networkidle can hang on long-lived SSE
      // connections that the chat surface keeps open by design.
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => {
          /* tolerate SSE-keepalive pages; the screenshot still captures the rendered DOM */
        })

      const outPath = path.join(OUT_DIR, `${pg.name}-${vp.name}.png`)
      await page.screenshot({ path: outPath, fullPage: true })

      // Sanity-check the file actually landed on disk so a silent
      // screenshot failure surfaces as a red test instead of a missing
      // artifact.
      expect(fs.existsSync(outPath), `screenshot not written: ${outPath}`).toBe(true)
      expect(fs.statSync(outPath).size, "screenshot is empty").toBeGreaterThan(0)
    })
  }
}
