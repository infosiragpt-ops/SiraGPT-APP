import { expect, test } from "@playwright/test"

/**
 * Frontend health smoke — Playwright runs against the Next.js dev
 * server on :3005 (see playwright.config.ts). The Next.js server
 * itself doesn't expose /health (that's the Express backend on
 * port 5000), but every route the i18n middleware accepts must at
 * minimum return a non-5xx response. This spec hits the few
 * top-level public routes that should never be 5xx in a healthy
 * build:
 *
 *   - /                  landing
 *   - /chat              chat surface (or a redirect)
 *   - /privacy-policy    public page
 *   - /icon.svg          static asset
 */
const PUBLIC_ROUTES = ["/", "/chat", "/privacy-policy", "/icon.svg"]

for (const route of PUBLIC_ROUTES) {
  test(`route ${route} does not 5xx`, async ({ page }) => {
    const response = await page.goto(route, { waitUntil: "domcontentloaded" })
    expect(response, `navigation to ${route} should resolve`).not.toBeNull()
    const status = response!.status()
    expect(status, `${route} returned ${status}`).toBeLessThan(500)
  })
}
