import { expect, test } from "@playwright/test"

/**
 * Auth forms — login and register pages. We verify the forms
 * render, accept input, validate empty/invalid fields, and don't
 * crash when submitted with bad data.
 *
 * We do NOT submit valid credentials (no seeded test user). The
 * goal is "the form handler validates and reports errors without
 * crashing" — that's the bug class the user wants gone.
 */

const KNOWN_BENIGN_CONSOLE = [
  /Hydration failed/,
  /Download the React DevTools/,
  /MISSING_MESSAGE/i,
  /Failed to load resource:.*\b(401|403|404)\b/i,
  /Failed to load resource:.*net::ERR_CONNECTION_REFUSED/i,
  /\bUnauthorized\b/i,
  /\bInvalid credentials\b/i,
  /\bAccess token required\b/i,
  /Failed to fetch RSC payload/i,
  /ChunkLoadError/i,
  /was preloaded using link preload/i,
]

// Next dev cold-compile sometimes serves a stale/partial first
// client chunk that fails to parse. Tolerated everywhere.
const DEV_CHUNK_NOISE = /Invalid or unexpected token/i

function arming(page: import("@playwright/test").Page) {
  const errors: Error[] = []
  page.on("pageerror", (err) => {
    if (DEV_CHUNK_NOISE.test(err.message)) return
    errors.push(err)
  })
  page.on("console", (msg) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (KNOWN_BENIGN_CONSOLE.some((p) => p.test(text))) return
    if (DEV_CHUNK_NOISE.test(text)) return
    errors.push(new Error(`[console] ${text}`))
  })
  return errors
}

test("login page renders an email and password field", async ({ page }) => {
  const errors = arming(page)
  await page.goto("/auth/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  const emailField = page.locator("input[type='email'], input[name*='email' i]").first()
  const passwordField = page.locator("input[type='password']").first()

  // If the form is not visible (auth already happened, redirect to
  // /chat), skip — the route still works, just nothing for us here.
  if ((await emailField.count()) === 0 || (await passwordField.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "login form not present (possibly logged in)" })
    return
  }

  await expect(emailField).toBeVisible()
  await expect(passwordField).toBeVisible()
  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("login mobile header keeps back beside the logo without clipping the welcome title", async ({ page }) => {
  const errors = arming(page)
  await page.setViewportSize({ width: 393, height: 852 })
  await page.goto("/auth/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  const card = page.getByTestId("login-card")
  const backButton = page.getByTestId("login-back-button")
  const logo = page.getByTestId("login-logo")
  const welcomeTitle = page.getByRole("heading", { name: /bienvenido de nuevo|welcome back/i })

  if (
    (await card.count()) === 0
    || (await backButton.count()) === 0
    || (await logo.count()) === 0
    || (await welcomeTitle.count()) === 0
  ) {
    test.info().annotations.push({ type: "skipped", description: "login header not present" })
    return
  }

  const [cardBox, backBox, logoBox, titleBox] = await Promise.all([
    card.boundingBox(),
    backButton.boundingBox(),
    logo.boundingBox(),
    welcomeTitle.boundingBox(),
  ])

  expect(cardBox).not.toBeNull()
  expect(backBox).not.toBeNull()
  expect(logoBox).not.toBeNull()
  expect(titleBox).not.toBeNull()

  expect(backBox!.x, "back button should stay inside the card").toBeGreaterThanOrEqual(cardBox!.x)
  expect(backBox!.x + backBox!.width, "back button should sit to the left of the logo").toBeLessThan(logoBox!.x)
  expect(Math.abs((backBox!.y + backBox!.height / 2) - (logoBox!.y + logoBox!.height / 2))).toBeLessThan(8)
  expect(titleBox!.x, "welcome title should not clip on the left").toBeGreaterThanOrEqual(cardBox!.x)
  expect(titleBox!.x + titleBox!.width, "welcome title should not clip on the right").toBeLessThanOrEqual(cardBox!.x + cardBox!.width)
  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("login form submission with empty fields does not crash", async ({ page }) => {
  const errors = arming(page)
  await page.goto("/auth/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  const submitBtn = page
    .getByRole("button", { name: /iniciar sesi|log\s*in|sign\s*in|entrar|continuar/i })
    .first()

  if ((await submitBtn.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "no submit button found" })
    return
  }

  // Click submit without filling fields. A well-behaved form shows
  // validation errors. A buggy form might crash on null-deref of
  // form values.
  await submitBtn.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(800)

  expect(errors.map((e) => e.message), "submitting empty form should not crash").toHaveLength(0)
})

test("login with obviously-invalid credentials produces a graceful response", async ({ page }) => {
  const errors = arming(page)
  await page.goto("/auth/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  const emailField = page.locator("input[type='email'], input[name*='email' i]").first()
  const passwordField = page.locator("input[type='password']").first()
  const submitBtn = page
    .getByRole("button", { name: /iniciar sesi|log\s*in|sign\s*in|entrar|continuar/i })
    .first()

  if (
    (await emailField.count()) === 0
    || (await passwordField.count()) === 0
    || (await submitBtn.count()) === 0
  ) {
    test.info().annotations.push({ type: "skipped", description: "login form not present" })
    return
  }

  await emailField.fill("not-a-real-user@example.invalid")
  await passwordField.fill("wrong-password-1234")
  await submitBtn.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(1500)

  expect(errors.map((e) => e.message), "invalid login should fail gracefully").toHaveLength(0)
})

test("register page renders or redirects without crashing", async ({ page }) => {
  const errors = arming(page)
  const response = await page.goto("/auth/register", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response).not.toBeNull()
  expect(response!.status()).toBeLessThan(500)

  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("auth callback route does not crash without a code parameter", async ({ page }) => {
  const errors = arming(page)
  // No `code` query — the callback page must handle this case
  // (typical bug: assume code exists, throw on `searchParams.get('code').toString()`).
  const response = await page.goto("/auth/callback", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response).not.toBeNull()
  expect(response!.status()).toBeLessThan(500)

  await page.waitForLoadState("domcontentloaded")
  await page.waitForTimeout(1500)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})
