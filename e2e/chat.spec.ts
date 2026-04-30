import { expect, test } from "@playwright/test"

/**
 * Chat surface smoke — verifies the `/chat` route is reachable and
 * boots without a server error. We deliberately do *not* assert
 * specific UI elements (composer textarea, send button, model
 * picker) because:
 *   - the page is locale-prefixed by the i18n middleware, so the
 *     final URL after navigation is `/<locale>/chat`,
 *   - depending on auth state, an anonymous visitor may be
 *     redirected to a login surface — that redirect is also a
 *     valid smoke result.
 *
 * The signal we're looking for is "the chat route does not 5xx".
 * Tightened assertions belong in a follow-up spec that stubs auth
 * or runs against a seeded test user.
 */
test("chat route resolves to either the chat page or a known auth page", async ({ page }) => {
  const response = await page.goto("/chat")
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)

  // The middleware either renders the chat surface (user is signed
  // in or anonymous mode is allowed) or redirects to /<locale>/login
  // / /<locale>/auth. Either is acceptable for the smoke.
  await page.waitForLoadState("networkidle", { timeout: 15_000 })
  const url = page.url()
  expect(url).toMatch(/\/(chat|login|auth|register|sign[-_]?in)/i)
})

/**
 * Document title and visible body — same shape as home.spec but
 * scoped to /chat so a regression that blanks the chat surface
 * surfaces as a CI failure instead of waiting for a user report.
 */
test("chat surface paints a title and a non-empty body", async ({ page }) => {
  await page.goto("/chat")
  await page.waitForLoadState("networkidle", { timeout: 15_000 })

  const title = await page.title()
  expect(title.trim().length, "document title should be set").toBeGreaterThan(0)

  const bodyText = await page.locator("body").innerText()
  expect(bodyText.trim().length, "body should render visible text").toBeGreaterThan(20)
})

/**
 * Locale negotiation — the same Accept-Language path home.spec
 * exercises, but also verifying the chat route honors the locale
 * prefix the middleware injects. Catches regressions where the
 * locale rewriter accidentally strips `/chat` to `/`.
 */
test("locale prefix is preserved through the /chat redirect", async ({ page }) => {
  const response = await page.goto("/chat", { waitUntil: "domcontentloaded" })
  expect(response, "navigation should resolve").not.toBeNull()
  // Either we're still at /chat (ok), or we're at /<locale>/chat
  // (also ok). What we never want is a hard drop to / on a request
  // that explicitly named the chat route.
  expect(page.url()).toMatch(/\/(?:[a-z]{2}\/)?(chat|login|auth|register|sign[-_]?in)/i)
})
