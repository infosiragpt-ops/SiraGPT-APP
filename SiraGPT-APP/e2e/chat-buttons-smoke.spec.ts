import { expect, test } from "@playwright/test"

/**
 * Chat buttons smoke — guards against "button click crashes the app".
 *
 * Why this exists
 * ───────────────
 * The chat surface has 70+ interactive controls (send, attach, stop,
 * model picker, sidebar toggle, share, copy link, regenerate, edit
 * message, feedback…). When a refactor breaks one handler — typo in
 * a state setter, missing optional chain, or a removed dependency —
 * the visible failure is usually a runtime exception that bubbles to
 * the React error boundary or a `Cannot read property X of undefined`
 * in the console. The user just sees a blank panel.
 *
 * This spec catches that whole class without needing a seeded auth
 * session: it loads the chat shell, captures every uncaught
 * pageerror and console error, then clicks every interactive control
 * it can find. Buttons that legitimately require auth/state will be
 * no-ops; what we care about is "none of them throw."
 *
 * Why we don't assert specific UI changes
 * ───────────────────────────────────────
 * Auth state varies (CI may not have a session). Buttons may be
 * disabled, conditionally rendered, or behind a modal we haven't
 * opened. Asserting "send button calls /api/chat" would need
 * authenticated session + mocked backend — out of scope for a
 * smoke. The smoke's value is the negative space: zero uncaught
 * errors after touching every button.
 *
 * Cold-start handling: same `domcontentloaded` strategy as the
 * neighboring chat.spec — the Next dev server's first compile of
 * the chat route is slow; `load` waits for streaming resources that
 * may never settle.
 */

const KNOWN_BENIGN_CONSOLE = [
  // Next.js dev-mode hydration noise we can't suppress without
  // touching the UI. Match conservatively.
  /Hydration failed/,
  /Text content does not match server-rendered HTML/,
  // React DevTools encouragement
  /Download the React DevTools/,
  // Browser-side warnings about missing audio worklet on first paint
  /AudioContext was not allowed to start/,
  // Service-worker / fetch lifecycle that is reported but harmless
  /Failed to load resource:.*favicon/i,
  // i18n missing-translation noise that the team tracks elsewhere
  /MISSING_MESSAGE/i,
  // GoogleAnalytics / posthog probes when network is offline in CI
  /Failed to fetch.*posthog/i,
  /Failed to fetch.*google/i,
]

function isBenignConsoleMessage(text: string): boolean {
  return KNOWN_BENIGN_CONSOLE.some((pattern) => pattern.test(text))
}

function isChatPage(url: string): boolean {
  return /\/(?:[a-z]{2}\/)?chat(?:$|[/?])/.test(url)
}

test("clicking every visible chat button does not throw an uncaught exception", async ({ page }) => {
  // Two separate buckets. Errors that fire during initial load
  // (bundle compile in Next dev, missing service-worker fetches,
  // hydration warnings) belong to `loadErrors` — they're flaky and
  // dev-server-specific. Errors that fire *after* we start clicking
  // belong to `clickErrors` — those are real handler bugs.
  const loadErrors: Error[] = []
  const clickErrors: Error[] = []
  const loadConsoleErrors: string[] = []
  const clickConsoleErrors: string[] = []
  let captureBucket: "load" | "click" = "load"

  page.on("pageerror", (err) => {
    if (captureBucket === "load") loadErrors.push(err)
    else clickErrors.push(err)
  })
  page.on("console", (msg) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (isBenignConsoleMessage(text)) return
    if (captureBucket === "load") loadConsoleErrors.push(text)
    else clickConsoleErrors.push(text)
  })

  const response = await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  // If we got redirected to an auth surface, this smoke has nothing
  // to do — the chat buttons aren't rendered yet.
  if (!isChatPage(page.url())) {
    test.info().annotations.push({ type: "skipped", description: `redirected to ${page.url()}` })
    return
  }

  // Wait for the surface to settle. We try to wait for either a
  // real button OR a known auth-gated marker, whichever comes
  // first. Either way we give the bundle time to finish loading
  // before we start interacting.
  await page.waitForTimeout(2500)

  // Capture all interactive elements we can find.
  const buttons = await page
    .locator("button:visible:not([disabled]), [role='button']:visible:not([aria-disabled='true'])")
    .all()

  // Auth-gated placeholder has no buttons. Don't fail the test for
  // load-time noise — that's noise we can't fix from this surface.
  if (buttons.length === 0) {
    test.info().annotations.push({
      type: "skipped",
      description: `chat shell rendered no buttons (auth-gated). Load errors: ${loadErrors.length} pageerror, ${loadConsoleErrors.length} console`,
    })
    return
  }

  // Switch buckets. From here on, any error is a click handler bug.
  captureBucket = "click"

  let clicked = 0
  let skipped = 0
  for (const btn of buttons) {
    // Re-check visibility each iteration — earlier clicks may have
    // collapsed a modal, opened a dropdown, or navigated.
    const visible = await btn.isVisible().catch(() => false)
    const enabled = await btn.isEnabled().catch(() => false)
    if (!visible || !enabled) {
      skipped += 1
      continue
    }

    // Read button label for diagnostics; some buttons are icon-only.
    const label = (await btn.getAttribute("aria-label").catch(() => null))
      ?? (await btn.textContent().catch(() => null))
      ?? "<unlabeled>"

    // `click({ trial: false })` so a button that opens a confirm
    // dialog still fires the handler. We never accept any dialog
    // that pops up — that's the "no destructive side effects" part
    // of a smoke. The handler running and synchronously throwing
    // is what we'd catch.
    page.once("dialog", (dialog) => {
      dialog.dismiss().catch(() => undefined)
    })

    try {
      await btn.click({ timeout: 1500, trial: false, force: false })
      clicked += 1
    } catch {
      // Click may legitimately fail (element moved, became detached,
      // hidden behind a modal). We don't fail the test on click
      // refusal — only on the handler throwing afterwards.
      skipped += 1
    }
    // Give any synchronous handler-side state update time to flush
    // before we move on. Async handlers will surface their errors
    // via `pageerror` regardless of how long we wait.
    await page.waitForTimeout(75)

    // Bail out early if the page navigated away from /chat — once
    // we leave, the remaining `btn` handles point at detached DOM
    // and further clicks are noise.
    if (!isChatPage(page.url())) {
      test.info().annotations.push({ type: "info", description: `navigated to ${page.url()} after clicking ${label}` })
      break
    }
  }

  test.info().annotations.push({
    type: "summary",
    description: `clicked ${clicked} / skipped ${skipped} of ${buttons.length} buttons`,
  })

  // Allow the React error boundary / async handlers to flush before
  // we assert. Without this delay, an `await fetch()` inside a
  // handler can throw on the microtask after our loop exits.
  await page.waitForTimeout(500)

  expect(clickErrors.map((e) => e.message), "no uncaught pageerror after clicking buttons").toHaveLength(0)
  expect(clickConsoleErrors, "no non-benign console errors after clicking buttons").toHaveLength(0)
})

/**
 * Typing in the composer should never crash — even a tiny refactor
 * that breaks the onChange handler (typo in setMessage, wrong ref)
 * fires a runtime error on the first keypress.
 */
test("typing into the chat composer does not throw", async ({ page }) => {
  const pageErrors: Error[] = []
  page.on("pageerror", (err) => pageErrors.push(err))

  const response = await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  if (!isChatPage(page.url())) {
    test.info().annotations.push({ type: "skipped", description: `redirected to ${page.url()}` })
    return
  }

  await page.waitForTimeout(2000)

  // The composer may be a <textarea> or a contenteditable. Try both.
  const composer = page
    .locator("textarea, [contenteditable='true'], [role='textbox']")
    .filter({ hasNot: page.locator("[aria-hidden='true']") })
    .first()

  if ((await composer.count()) === 0) {
    test.info().annotations.push({ type: "skipped", description: "composer not present in DOM" })
    return
  }

  await composer.click({ timeout: 5000 }).catch(() => undefined)
  await composer.type("Hola, esto es una prueba E2E.", { delay: 25 }).catch(() => undefined)

  await page.waitForTimeout(300)
  expect(pageErrors.map((e) => e.message), "no uncaught pageerror after typing").toHaveLength(0)
})
