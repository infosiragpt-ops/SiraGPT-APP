import { expect, test } from "@playwright/test"

/**
 * Admin smoke — covers every /admin/* subroute for no-crash on
 * initial paint. Same shape as routes-smoke.spec.ts but scoped to
 * the admin surface so a regression in (say) /admin/analytics is
 * caught even when /admin itself works.
 *
 * Same auth-tolerant behaviour: a redirect to login or an empty
 * auth-gated shell is acceptable; what we reject is a 5xx or a
 * runtime crash that bubbles to pageerror.
 */

const ADMIN_ROUTES = [
  "/admin",
  "/admin/analytics",
  "/admin/database",
  "/admin/health",
  "/admin/invoices",
  "/admin/models",
  "/admin/payments",
  "/admin/reports",
  "/admin/security",
  "/admin/settings",
  "/admin/users",
]

const KNOWN_BENIGN_CONSOLE = [
  /Hydration failed/,
  /Text content does not match server-rendered HTML/,
  /Download the React DevTools/,
  /AudioContext was not allowed to start/,
  /Failed to load resource:.*favicon/i,
  /MISSING_MESSAGE/i,
  /Failed to fetch.*posthog/i,
  /Failed to fetch.*google/i,
  /was preloaded using link preload/i,
  /was not used within a few seconds/i,
  /Failed to load resource:.*\b(401|403|404)\b/i,
  /\bAccess token required\b/i,
  /\bUnauthorized\b/i,
  /\bAuthentication required\b/i,
  /\bToken expired\b/i,
  /\bAdmin access required\b/i,
  /\bForbidden\b/i,
  /\bFailed to load (?:users|invoices|payments|reports|analytics|models|database|settings|health|security|stats|metrics)/i,
  /User not authenticated/i,
  /CORS policy/i,
  /net::ERR_FAILED/i,
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_NAME_NOT_RESOLVED/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
  /MIME type \(['"]text\/html['"]\) is not executable/i,
  /Failed to fetch RSC payload/i,
  /Refused to execute script from/i,
  /strict MIME type checking is enabled/i,
  /Refused to display .* in a frame/i,
]
function isBenign(text: string): boolean {
  return KNOWN_BENIGN_CONSOLE.some((p) => p.test(text))
}
function isDevChunkArtifact(message: string): boolean {
  return /Invalid or unexpected token/i.test(message)
}

for (const route of ADMIN_ROUTES) {
  test(`${route} resolves and does not crash on initial paint`, async ({ page }) => {
    const errors: { source: "page" | "console"; text: string }[] = []

    page.on("pageerror", (err) => {
      if (isDevChunkArtifact(err.message)) return
      errors.push({ source: "page", text: err.message })
    })
    page.on("console", (msg) => {
      if (msg.type() !== "error") return
      const text = msg.text()
      if (isBenign(text)) return
      if (isDevChunkArtifact(text)) return
      errors.push({ source: "console", text })
    })

    const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 })
    expect(response, `navigation to ${route} should resolve`).not.toBeNull()
    expect(response!.status(), `${route} returned ${response!.status()}`).toBeLessThan(500)

    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

    const title = await page.title()
    expect(title.trim().length, `${route} should have a non-empty <title>`).toBeGreaterThan(0)

    await page.waitForTimeout(1500)

    expect(
      errors.map((e) => `[${e.source}] ${e.text}`),
      `${route} produced uncaught errors during load`,
    ).toHaveLength(0)
  })
}
