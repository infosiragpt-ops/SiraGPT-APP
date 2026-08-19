import { expect, test } from "@playwright/test"

/**
 * Smoke test: the app's home page renders without a server error,
 * returns 2xx, and actually paints something visible in the DOM.
 *
 * This is intentionally minimal — it's the "canary" test that proves
 * the whole frontend build + middleware + i18n pipeline boots cleanly.
 * Feature-specific behavior gets covered in separate spec files as
 * they stabilize.
 */
test("home page loads and renders", async ({ page }) => {
  const response = await page.goto("/")
  expect(response, "navigation should resolve").not.toBeNull()
  expect(response!.ok(), `home returned ${response!.status()}`).toBe(true)

  // The middleware auto-redirects to a locale-prefixed path (/es or /en
  // depending on Accept-Language); both should render the landing page.
  await expect(page).toHaveURL(/\/(es|en|pt|fr|de|it|ja|zh|ru|ar|hi|ko)(\/|$)|\/$/)

  // Give the client a moment to hydrate, then confirm the body isn't
  // blank and the document title is set. We accept either marketing
  // content (~20+ chars) OR the auth-guard's "Cargando Sira GPT" shell
  // (~9 chars in innerText) — both are valid rendered states.
  await page.waitForLoadState("networkidle", { timeout: 15_000 })
  const title = await page.title()
  expect(title.trim().length, "document title should be set").toBeGreaterThan(0)
  const bodyText = await page.locator("body").innerText()
  expect(bodyText.trim().length, "body should render visible text").toBeGreaterThan(0)
})
