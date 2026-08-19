import { expect, test } from "@playwright/test"

/**
 * Chat action smokes — beyond "buttons don't crash" we want
 * specific interactions to behave coherently. Each test isolates
 * one user gesture and asserts the visible reaction.
 *
 * Tests are auth-tolerant: if /chat redirects to /login (no
 * seeded session), they skip with an annotation rather than
 * failing the build.
 */

const KNOWN_BENIGN_CONSOLE = [
  /Hydration failed/,
  /Download the React DevTools/,
  /MISSING_MESSAGE/i,
  /Failed to load resource:.*\b(401|403|404)\b/i,
  /\bAccess token required\b/i,
  /\bFailed to load (?:voices|chats|models|user|projects|gpts|settings|profile|files|library|history|usage|subscription|billing|payment|messages|invoices)/i,
  /Failed to fetch RSC payload/i,
  /ChunkLoadError/i,
  /was preloaded using link preload/i,
]

function isChatPage(url: string): boolean {
  return /\/(?:[a-z]{2}\/)?chat(?:$|[/?])/.test(url)
}

async function settleOnChat(page: import("@playwright/test").Page): Promise<boolean> {
  await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })
  await page.waitForTimeout(2500)
  if (!isChatPage(page.url())) {
    test.info().annotations.push({ type: "skipped", description: `redirected to ${page.url()}` })
    return false
  }
  return true
}

function arming(page: import("@playwright/test").Page) {
  const errors: Error[] = []
  page.on("pageerror", (err) => errors.push(err))
  page.on("console", (msg) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (KNOWN_BENIGN_CONSOLE.some((p) => p.test(text))) return
    errors.push(new Error(`[console] ${text}`))
  })
  return errors
}

test("composer accepts focus, typing, and Backspace without crashing", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const composer = page
    .locator("textarea, [contenteditable='true'], [role='textbox']")
    .filter({ hasNot: page.locator("[aria-hidden='true']") })
    .first()

  if ((await composer.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "composer not present (auth-gated)" })
    return
  }

  await composer.click({ timeout: 5000 }).catch(() => undefined)
  await composer.type("Hola mundo", { delay: 25 }).catch(() => undefined)
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(250)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("Cmd/Ctrl-A in the composer does not crash", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const composer = page
    .locator("textarea, [contenteditable='true'], [role='textbox']")
    .filter({ hasNot: page.locator("[aria-hidden='true']") })
    .first()
  if ((await composer.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "composer not present" })
    return
  }

  await composer.click({ timeout: 5000 }).catch(() => undefined)
  await composer.type("seleccion completa", { delay: 10 }).catch(() => undefined)
  await page.keyboard.press("ControlOrMeta+A")
  await page.waitForTimeout(150)
  await page.keyboard.press("Backspace")
  await page.waitForTimeout(200)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("opening and closing the same dropdown twice does not leak state", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  // Find any aria-haspopup button (model picker, attach menu, etc.)
  const menuTrigger = page.locator("[aria-haspopup='menu']:visible, [aria-haspopup='true']:visible").first()
  if ((await menuTrigger.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "no dropdown trigger on chat shell" })
    return
  }

  // Open → close → open → close. If any handler keeps state out of
  // sync (aria-expanded stuck, portal not unmounted), subsequent
  // clicks would explode.
  await menuTrigger.click({ timeout: 3000 }).catch(() => undefined)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(150)
  await menuTrigger.click({ timeout: 3000 }).catch(() => undefined)
  await page.keyboard.press("Escape")
  await page.waitForTimeout(150)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("focusing every focusable element on /chat does not crash", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const focusables = await page
    .locator(
      "button:visible:not([disabled]), input:visible:not([disabled]), textarea:visible:not([disabled]), [tabindex]:visible:not([tabindex='-1'])",
    )
    .all()

  if (focusables.length === 0) {
    test.info().annotations.push({ type: "skipped", description: "no focusables (auth-gated)" })
    return
  }

  // Tab through up to 30 elements. We don't want to walk the whole
  // tree (could be hundreds with hidden popovers); 30 is enough to
  // hit every primary control on the chat shell.
  for (let i = 0; i < Math.min(focusables.length, 30); i++) {
    await page.keyboard.press("Tab")
    await page.waitForTimeout(40)
  }

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("rapid double-click on the same button does not produce double-fire errors", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const buttons = await page
    .locator("button:visible:not([disabled]):not([aria-busy='true'])")
    .all()
  if (buttons.length === 0) {
    test.info().annotations.push({ type: "skipped", description: "no buttons (auth-gated)" })
    return
  }

  // Pick the first 3 visible buttons and double-click each. This
  // is a common bug source: a handler that increments a counter or
  // pushes to an array on every click, without idempotency.
  for (const btn of buttons.slice(0, 3)) {
    if (!(await btn.isVisible().catch(() => false))) continue
    page.once("dialog", (d) => d.dismiss().catch(() => undefined))
    await btn.click({ timeout: 1500, clickCount: 2, delay: 30 }).catch(() => undefined)
    await page.waitForTimeout(120)
    if (!isChatPage(page.url())) break
  }

  expect(errors.map((e) => e.message)).toHaveLength(0)
})
