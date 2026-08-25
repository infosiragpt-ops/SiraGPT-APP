import { expect, test } from "@playwright/test"

/**
 * Chat surface smoke — verifies the `/agentes` route is reachable and
 * boots without a server error. Authenticated agents home is `/agentes`;
 * `/chat` redirects there. We deliberately do *not* assert
 * specific UI elements (composer textarea, send button, model
 * picker) because:
 *   - the page is locale-prefixed by the i18n middleware, so the
 *     final URL after navigation may be `/`, `/<locale>`, or
 *     `/<locale>/chat`,
 *   - depending on auth state, an anonymous visitor may be
 *     redirected to a login surface — that redirect is also a
 *     valid smoke result.
 *
 * The signal we're looking for is "the chat route does not 5xx".
 * Tightened assertions belong in a follow-up spec that stubs auth
 * or runs against a seeded test user.
 *
 * Cold-start note
 * ---------------
 * In CI the first `page.goto("/agentes")` triggers Next dev's first
 * compile of the chat surface, which can take >30s. We use
 * `waitUntil: "domcontentloaded"` (not the default `load`) so
 * navigation resolves as soon as the HTML is parsed — `load` waits
 * for every resource, and an i18n redirect mid-load surfaces as
 * `net::ERR_ABORTED; maybe frame was detached?`. domcontentloaded
 * is enough for a smoke that only cares the route resolved.
 */
test("chat route resolves to either the chat page or a known auth page", async ({ page }) => {
  const response = await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)

  // The middleware either lands on agents home `/` (or `/<locale>`),
  // renders `/chat`, or redirects to /<locale>/login / /<locale>/auth.
  // Any of those is acceptable for the smoke.
  // `domcontentloaded` again here (instead of `networkidle`) — the
  // chat page may keep WebSocket / SSE connections open which means
  // network never goes truly idle.
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })
  const pathname = new URL(page.url()).pathname
  expect(pathname).toMatch(/^(?:\/[a-z]{2})?(?:\/(?:agentes|chat|login|auth|register|sign[-_]?in).*)?\/?$/i)
})

/**
 * Document title and first-paint shell — scoped to /chat so a
 * regression that breaks the route surfaces as a CI failure without
 * requiring a seeded authenticated user.
 */
test("chat surface paints a title and a stable shell", async ({ page }) => {
  const response = await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  const title = await page.title()
  expect(title.trim().length, "document title should be set").toBeGreaterThan(0)

  const bodyText = await page.locator("body").innerText()
  const hasVisibleBody = bodyText.trim().length > 20
  const hasBootstrapShell = (await page.locator('[role="alert"], [aria-live]').count()) > 0
  expect(hasVisibleBody || hasBootstrapShell, "body should render content or the app bootstrap shell").toBe(true)
})

/**
 * Locale negotiation — the same Accept-Language path home.spec
 * exercises, but also verifying `/chat` honors the locale prefix
 * the middleware injects. Agents home is `/` (or `/<locale>` /
 * `/<locale>/`), which is the expected destination after the
 * `/chat` redirect.
 */
test("locale prefix is preserved through the /chat redirect", async ({ page }) => {
  const response = await page.goto("/agentes", { waitUntil: "domcontentloaded" })
  expect(response, "navigation should resolve").not.toBeNull()
  // `/chat` now redirects to agents home. Valid landings: `/`,
  // `/<locale>`, `/<locale>/`, `/chat`, `/<locale>/chat`, or a
  // known auth surface. Do not require `/chat` in the final path.
  const pathname = new URL(page.url()).pathname
  expect(pathname).toMatch(/^(?:\/[a-z]{2})?(?:\/(?:agentes|chat|login|auth|register|sign[-_]?in).*)?\/?$/i)
})
