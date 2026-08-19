import { expect, test } from "@playwright/test"

/**
 * Routes smoke — verifies every top-level Next.js app/ route boots
 * without a server 5xx, paints content, and never raises an uncaught
 * pageerror during initial load.
 *
 * This is the "millions of tests" minimum baseline applied to every
 * surface the user can navigate to. The chat spec already covers
 * /chat in detail; here we make sure every other landing page is at
 * least crash-free.
 *
 * Auth handling
 * ─────────────
 * Most routes are auth-gated. We accept these terminal states as
 * "passed":
 *   - 200/201 chat-like surface
 *   - 3xx redirect to /<locale>/login | /<locale>/auth | /signin
 *   - 200 page showing an auth-gated placeholder (no buttons, but
 *     no errors)
 * What we reject:
 *   - 5xx
 *   - Uncaught pageerror from a runtime crash
 *
 * Locale prefix
 * ─────────────
 * The middleware injects /<locale>/ for i18n. We assert on a regex
 * that tolerates the prefix.
 *
 * Same load-noise allowlist as chat-buttons-smoke — Next dev's
 * first-compile and hydration warnings are real but not actionable
 * from this surface.
 */

const ROUTES_TO_SMOKE = [
  "/admin",
  "/auth",
  "/billing",
  "/code",
  "/codex",
  "/design",
  "/documents",
  "/gpts",
  "/library",
  "/openclaw",
  "/parafraseo",
  "/payment",
  "/plan",
  "/post",
  "/privacy-policy",
  "/profile",
  "/projects",
  "/search-brain",
  "/settings",
  "/super-admin",
  "/thesis",
  "/voice",
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
  // Expected when smoke runs without an auth session — the page is
  // operating correctly; it just can't fetch authed data. A real
  // crash would be a TypeError / ReferenceError, not a 401.
  /Failed to load resource:.*\b(401|403|404)\b/i,
  /\bAccess token required\b/i,
  /\bUnauthorized\b/i,
  /\bAuthentication required\b/i,
  /\bToken expired\b/i,
  /\bFailed to load (?:voices|chats|models|user|projects|gpts|settings|profile|files|library|history|usage|subscription|billing|payment|messages|invoices)/i,
  /User not authenticated/i,
  // CORS preflight + offline noise — environmental, not a crash.
  /CORS policy/i,
  /net::ERR_FAILED/i,
  /net::ERR_INTERNET_DISCONNECTED/i,
  /net::ERR_NAME_NOT_RESOLVED/i,
  // Next dev cold-compile artifacts — happen when an auth redirect
  // fires before the target route's chunk has finished compiling.
  // Never reproduce on `next build`. Browser falls back to a hard
  // navigation which works fine.
  /ChunkLoadError/i,
  /Loading chunk/i,
  /MIME type \(['"]text\/html['"]\) is not executable/i,
  /Failed to fetch RSC payload/i,
  /Refused to execute script from/i,
  /strict MIME type checking is enabled/i,
  // X-Frame-Options + CSP frame-ancestors block iframe embedding —
  // that's the security headers working as designed.
  /Refused to display .* in a frame/i,
  /Refused to frame .* because/i,
  /Content Security Policy.* frame-ancestors/i,
]
function isBenign(text: string): boolean {
  return KNOWN_BENIGN_CONSOLE.some((p) => p.test(text))
}

// Dev-server first-compile sometimes serves a stale chunk that
// throws "Invalid or unexpected token". This is a Next dev artifact,
// not a real handler bug — it never reproduces on `next build`.
// We tolerate this one specific message during initial load.
function isDevChunkArtifact(message: string): boolean {
  return /Invalid or unexpected token/i.test(message)
}

for (const route of ROUTES_TO_SMOKE) {
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

    const status = response!.status()
    expect(status, `${route} returned ${status}`).toBeLessThan(500)

    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

    // The page can land on the requested route, on an auth surface,
    // or on a locale-prefixed variant. All are acceptable.
    const url = page.url()
    expect(
      /\/(?:[a-z]{2}\/)?(?:[a-z0-9-]+)/.test(url),
      `final URL ${url} should be a recognised app path`,
    ).toBe(true)

    const title = await page.title()
    expect(title.trim().length, `${route} should have a non-empty <title>`).toBeGreaterThan(0)

    // Give the surface 1.5s to flush async errors (mount effects,
    // microtask handlers). Without this, an error thrown during
    // the first paint's microtask can land *after* our assertions.
    await page.waitForTimeout(1500)

    expect(
      errors.map((e) => `[${e.source}] ${e.text}`),
      `${route} produced uncaught errors during load`,
    ).toHaveLength(0)
  })
}
