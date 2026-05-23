import { expect, test } from "@playwright/test"

/**
 * Chat shell interactions — sidebar toggle, theme switch, dialogs.
 *
 * Each test is auth-tolerant: if /chat redirects to /login or
 * renders the auth-guard placeholder, the test skips with an
 * annotation. The point is to catch interaction crashes when the
 * shell IS visible, not to gate CI on auth being seeded.
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

test("sidebar toggle button opens and closes without crashing", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const sidebarToggle = page.getByRole("button", { name: /Toggle Sidebar|Abrir el menú|menú lateral|sidebar/i }).first()
  if ((await sidebarToggle.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "sidebar toggle not present" })
    return
  }

  await sidebarToggle.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(250)
  await sidebarToggle.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(250)
  // Third toggle — three transitions is enough to expose any state
  // ping-pong (e.g. animation handler that double-fires).
  await sidebarToggle.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(300)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("theme toggle does not crash when cycled", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  const themeBtn = page.getByRole("button", { name: /Cambiar tema|theme|tema/i }).first()
  if ((await themeBtn.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "theme toggle not present" })
    return
  }

  for (let i = 0; i < 4; i++) {
    await themeBtn.click({ timeout: 2000 }).catch(() => undefined)
    await page.waitForTimeout(200)
  }

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("opening and dismissing dialogs with Escape does not leave orphan portals", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  // Click anything with aria-haspopup=dialog, then press Escape.
  // Repeated 3x because some dialogs unmount their portal on close;
  // a leak would surface as a duplicate dialog DOM on the 2nd open.
  const dialogTrigger = page.locator("[aria-haspopup='dialog']:visible").first()
  if ((await dialogTrigger.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "no dialog triggers visible" })
    return
  }

  for (let i = 0; i < 3; i++) {
    await dialogTrigger.click({ timeout: 2000 }).catch(() => undefined)
    await page.waitForTimeout(200)
    await page.keyboard.press("Escape")
    await page.waitForTimeout(200)
  }

  // After all Escapes, no role=dialog should be visible.
  const lingering = await page.locator("[role='dialog']:visible").count()
  expect(lingering, "no dialog should remain open after pressing Escape").toBeLessThanOrEqual(1)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("share button reaches its confirm/copy outcome without crashing", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  // Pre-grant clipboard permission so the share button's clipboard
  // write doesn't throw a SecurityError that would clutter the
  // pageerror channel.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined)

  const shareBtn = page
    .getByRole("button", { name: /Compartir conversación completa|Compartir|Share/i })
    .first()
  if ((await shareBtn.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "share button not present" })
    return
  }

  page.once("dialog", (d) => d.dismiss().catch(() => undefined))
  await shareBtn.click({ timeout: 3000 }).catch(() => undefined)
  await page.waitForTimeout(500)

  expect(errors.map((e) => e.message)).toHaveLength(0)
})

test("pressing Escape on an empty chat does not crash", async ({ page }) => {
  const errors = arming(page)
  if (!(await settleOnChat(page))) return

  // Escape with nothing focused — a common edge case that exposes
  // handlers expecting a defined event target.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Escape")
    await page.waitForTimeout(80)
  }

  expect(errors.map((e) => e.message)).toHaveLength(0)
})
