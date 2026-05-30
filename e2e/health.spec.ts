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
const PUBLIC_ROUTES = ["/", "/chat", "/privacy-policy", "/icon.svg", "/api/health", "/api/health/live"]

for (const route of PUBLIC_ROUTES) {
  test(`route ${route} does not 5xx`, async ({ page }) => {
    // 60s timeout for cold-compile in Next dev; the navigation
    // itself is short once the route is built, but the *first*
    // request after `next dev` boots blocks while Webpack compiles
    // the page bundle. Without this the spec is flaky in CI.
    const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 })
    expect(response, `navigation to ${route} should resolve`).not.toBeNull()
    const status = response!.status()
    expect(status, `${route} returned ${status}`).toBeLessThan(500)
  })
}

test("api health supports the connection status HEAD probe", async ({ request }) => {
  const response = await request.head("/api/health")

  expect(response.status()).toBeLessThan(400)
  expect(await response.text()).toBe("")
})

test("api health returns dashboard-compatible JSON", async ({ request }) => {
  const response = await request.get("/api/health")
  const body = await response.json()

  expect(response.status()).toBe(200)
  expect(body).toEqual(
    expect.objectContaining({
      status: expect.any(String),
      timestamp: expect.any(String),
      checks: expect.any(Array),
    }),
  )
  expect(body.checks.some((check: { name?: string }) => check.name === "frontend")).toBe(true)
})

test("api health live is frontend-only and lightweight", async ({ request }) => {
  const response = await request.get("/api/health/live")
  const body = await response.json()

  expect(response.status()).toBe(200)
  expect(body.status).toBe("healthy")
  expect(body.checks).toEqual([
    expect.objectContaining({ name: "frontend", status: "healthy" }),
  ])
})
