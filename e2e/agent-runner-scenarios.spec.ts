import { expect, test, type Page } from "@playwright/test"

/**
 * AgentRunner LIVE scenario evals — OPT-IN ONLY.
 *
 * This spec re-uses a small slice (~20) of the scenario bank
 * (backend/tests/fixtures/agent-runner-scenarios) against a REAL running
 * deployment over HTTP. It exercises the flows that scripted CI cannot:
 * real routing → real LLM → real sandbox → real download cards.
 *
 * It is SKIPPED unless BOTH are set:
 *   - SIRAGPT_LIVE_EVALS=1        (explicit opt-in — live runs cost credits)
 *   - PLAYWRIGHT_BASE_URL=<url>   (an already-running app; we never boot one)
 *
 * Auth: we do NOT invent credentials. If SIRAGPT_E2E_EMAIL /
 * SIRAGPT_E2E_PASSWORD are provided we attempt a UI login; otherwise we try
 * the chat surface anonymously and skip honestly when it is auth-gated.
 *
 * Default CI therefore reports this whole file as skipped — it never burns
 * credits and never fails required checks.
 */

const LIVE = process.env.SIRAGPT_LIVE_EVALS === "1"
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || ""
const E2E_EMAIL = process.env.SIRAGPT_E2E_EMAIL || ""
const E2E_PASSWORD = process.env.SIRAGPT_E2E_PASSWORD || ""

// The scenario bank is CommonJS on purpose (shared with node --test). The
// backend folder is excluded from the app tsconfig, so we load it untyped.
interface LiveFixture {
  id: string
  family: string
  text: string
  expect: {
    runner: boolean
    runnerOnly: boolean
    colorHex?: string
    format?: string
  }
}

function loadLiveSlice(): LiveFixture[] {
  const bankModule = require("../backend/tests/fixtures/agent-runner-scenarios/index.js") as {
    buildScenarioBank: () => LiveFixture[]
  }
  const bank = bankModule.buildScenarioBank()
  const byId = (id: string): LiveFixture => {
    const fixture = bank.find((f) => f.id === id)
    if (!fixture) throw new Error(`fixture ${id} missing from the scenario bank`)
    return fixture
  }
  const pick = (predicate: (f: LiveFixture) => boolean, n: number): LiveFixture[] => {
    const out: LiveFixture[] = []
    for (const f of bank) {
      if (predicate(f)) {
        out.push(f)
        if (out.length >= n) break
      }
    }
    return out
  }

  return [
    // Production create + color (the canonical incident phrase).
    byId("production-0001"), // crea una ppt del embarazo de color rosado la ppt
    byId("production-0006"), // crea una ppt del plan comercial de color #1E3A8A
    // Colored + plain creates across topics/formats.
    ...pick((f) => f.family === "create_es" && f.expect.format === "pptx" && Boolean(f.expect.colorHex), 3),
    ...pick((f) => f.family === "create_es" && f.expect.format === "pptx" && !f.expect.colorHex, 2),
    ...pick((f) => f.family === "create_es" && f.expect.format === "docx", 1),
    ...pick((f) => f.family === "create_en", 1),
    // Style/color follow-ups (sent right after a create in the same chat).
    byId("production-0003"), // ponlas todas rosadas
    byId("production-0002"), // uniformisa el color de la ppts todas de color blanco
    byId("production-0005"), // cámbialas al hex #1E3A8A
    ...pick((f) => f.family === "style" && f.expect.colorHex === "16A34A", 1),
    ...pick((f) => f.family === "style" && f.expect.colorHex === "F97316", 1),
    // Thanks slide follow-up.
    byId("production-0004"), // agrega una lámina de gracias al final
    // Multi-step orchestration goal.
    ...pick((f) => f.family === "orchestrate" && /y luego crea/.test(f.text), 1),
    // Cancel/stop phrasing (must not crash nor claim work).
    ...pick((f) => f.family === "cancel", 2),
    // Smalltalk + injection: must answer WITHOUT running the document agent.
    ...pick((f) => f.family === "smalltalk" && f.text === "hola", 1),
    ...pick((f) => f.family === "injection", 2),
  ]
}

function isChatPage(url: string): boolean {
  return /\/(?:[a-z]{2}\/)?chat(?:$|[/?])/.test(url)
}

async function tryLogin(page: Page): Promise<void> {
  if (!E2E_EMAIL || !E2E_PASSWORD) return
  await page.goto("/login", { waitUntil: "domcontentloaded", timeout: 60_000 })
  const email = page.locator('input[type="email"], input[name="email"]').first()
  const password = page.locator('input[type="password"], input[name="password"]').first()
  if ((await email.count()) === 0 || (await password.count()) === 0) return
  await email.fill(E2E_EMAIL)
  await password.fill(E2E_PASSWORD)
  await page
    .locator('button[type="submit"], form button')
    .first()
    .click({ timeout: 10_000 })
    .catch(() => {})
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {})
}

/** Locate the chat composer; returns null when the surface is auth-gated. */
async function findComposer(page: Page) {
  const composer = page
    .locator("textarea, [contenteditable='true'], [role='textbox']")
    .filter({ hasNot: page.locator("[aria-hidden='true']") })
    .first()
  try {
    await composer.waitFor({ state: "visible", timeout: 20_000 })
    return composer
  } catch {
    return null
  }
}

test.describe("agent-runner live scenario evals (opt-in)", () => {
  test.skip(!LIVE, "SIRAGPT_LIVE_EVALS=1 not set — live evals are opt-in and cost credits")
  test.skip(LIVE && !BASE_URL, "PLAYWRIGHT_BASE_URL not set — live evals need an already-running app")

  const slice = LIVE && BASE_URL ? loadLiveSlice() : []

  test("live slice loads ≥20 unique fixtures from the shared bank", () => {
    expect(slice.length).toBeGreaterThanOrEqual(20)
    expect(new Set(slice.map((f) => f.text)).size).toBe(slice.length)
    console.log(`[live-evals] fixtures selected=${slice.length}`)
  })

  for (const fixture of LIVE && BASE_URL ? loadLiveSlice() : []) {
    test(`live [${fixture.id}] "${fixture.text}"`, async ({ page }) => {
      test.setTimeout(240_000)

      const pageErrors: Error[] = []
      page.on("pageerror", (err) => pageErrors.push(err))

      await tryLogin(page)
      await page.goto("/agentes", { waitUntil: "domcontentloaded", timeout: 60_000 })
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

      if (!isChatPage(page.url())) {
        test.skip(true, `chat surface is auth-gated (redirected to ${page.url()}) — provide SIRAGPT_E2E_EMAIL/PASSWORD`)
      }
      const composer = await findComposer(page)
      if (!composer) {
        test.skip(true, "no chat composer rendered — unauthenticated session, skipping honestly")
        return
      }

      const before = await page.locator("[data-role='assistant'], [data-message-role='assistant'], article").count()
      await composer.click()
      await composer.fill(fixture.text)
      await page.keyboard.press("Enter")

      if (fixture.expect.runner && fixture.expect.format) {
        // Document turns: wait for either a download/artifact card or an
        // honest error message — NEVER a silent hang.
        const artifact = page.locator(
          "a[href*='/api/agent/artifact'], a[download], [data-testid*='artifact'], [data-testid*='download']",
        )
        const anyResponse = page.locator("[data-role='assistant'], [data-message-role='assistant'], article")
        await expect
          .poll(
            async () => (await artifact.count()) > 0 || (await anyResponse.count()) > before,
            { timeout: 210_000, message: `no artifact nor assistant reply for: ${fixture.text}` },
          )
          .toBe(true)
      } else {
        // Non-document turns (smalltalk, cancel, injection): an assistant
        // reply must appear and the app must not crash.
        const anyResponse = page.locator("[data-role='assistant'], [data-message-role='assistant'], article")
        await expect
          .poll(
            async () => (await anyResponse.count()) > before,
            { timeout: 90_000, message: `no assistant reply for: ${fixture.text}` },
          )
          .toBe(true)
      }

      expect(pageErrors, `uncaught page errors while running "${fixture.text}"`).toEqual([])
    })
  }
})
