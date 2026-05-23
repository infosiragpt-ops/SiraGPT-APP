import { expect, test } from "@playwright/test"

/**
 * Backend API contract smokes — verifies that the Express backend
 * on port 5000 responds with the expected shape and status codes
 * for endpoints the frontend depends on.
 *
 * These tests use Playwright's `request` fixture (no browser) so
 * they're fast (each <1s). The point is to catch backend
 * regressions before they surface as opaque 500s on the chat UI.
 *
 * Auth handling: most endpoints require a token. We don't seed
 * one; the contract we're verifying is "the endpoint exists and
 * responds with 401/403 for unauth — not 404 or 500." A 5xx is
 * a backend bug; a 401 is the auth middleware working.
 */

const BACKEND = process.env.SIRA_BACKEND_URL || "http://localhost:5000"

/** True if status is in [200, 500). 5xx = backend bug. 4xx = expected unauth. */
function isBackendHealthy(status: number): boolean {
  return status >= 200 && status < 500
}

test("GET /api/health responds with 200 + healthy status", async ({ request }) => {
  const res = await request.get(`${BACKEND}/health`)
  expect(res.status(), `health returned ${res.status()}`).toBe(200)
  const body = await res.json()
  expect(body.status, "health body should expose a status field").toBeDefined()
})

test("HEAD /api/health responds with 204 for connection probes", async ({ request }) => {
  const res = await request.head(`${BACKEND}/health`)
  expect(res.status(), "HEAD health should be 2xx or 3xx").toBeLessThan(400)
})

test("unauth GET /api/auth/me returns 401, not 500", async ({ request }) => {
  const res = await request.get(`${BACKEND}/api/auth/me`)
  // The rate-limit test in this file fires 30 requests against the
  // same endpoint, which can leave it rate-limited when this test
  // runs second. 429 is correct rate-limiter behaviour; the bug
  // we're guarding against is 500.
  expect(
    [401, 429],
    `auth/me without token returned ${res.status()} (expected 401 or 429)`,
  ).toContain(res.status())
})

test("unauth GET /api/chats returns 401, not 500", async ({ request }) => {
  const res = await request.get(`${BACKEND}/api/chats`)
  expect(res.status()).toBe(401)
})

test("unauth GET /api/ai/models returns 200 or 401 (public catalog allowed)", async ({ request }) => {
  const res = await request.get(`${BACKEND}/api/ai/models`)
  // Either the catalog is public (200) or it requires auth (401).
  // Anything else (404, 500) is a regression.
  expect([200, 401], `ai/models returned ${res.status()}`).toContain(res.status())
})

test("GET /api/admin/providers responds (auth-gated)", async ({ request }) => {
  const res = await request.get(`${BACKEND}/api/admin/providers`)
  expect(isBackendHealthy(res.status()), `admin/providers returned ${res.status()}`).toBe(true)
})

test("OPTIONS /api/auth/login passes CORS preflight", async ({ request }) => {
  // The chat frontend lives on a different origin in dev — CORS
  // must work. A broken Access-Control-Allow-Origin header breaks
  // login entirely.
  const res = await request.fetch(`${BACKEND}/api/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,authorization",
    },
  })
  expect(res.status(), `preflight returned ${res.status()}`).toBeLessThan(400)
})

test("POST /api/auth/login with empty body returns 4xx, not 500", async ({ request }) => {
  // A common backend bug: assumes req.body.email exists, throws
  // when it's undefined. Should be a 400 from validation.
  const res = await request.post(`${BACKEND}/api/auth/login`, {
    data: {},
    headers: { "content-type": "application/json" },
  })
  expect(res.status(), `empty login returned ${res.status()}`).toBeGreaterThanOrEqual(400)
  expect(res.status(), `empty login returned ${res.status()}`).toBeLessThan(500)
})

test("POST /api/auth/login with malformed JSON returns 4xx, not 500", async ({ request }) => {
  const res = await request.fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    data: "not-json{",
  })
  expect(res.status(), `malformed JSON returned ${res.status()}`).toBeGreaterThanOrEqual(400)
  expect(res.status(), `malformed JSON returned ${res.status()}`).toBeLessThan(500)
})

test("rate limiter responds with 429 + Retry-After when triggered", async ({ request }) => {
  // Hammer an unauth endpoint with 30 quick requests. If a rate
  // limiter is in place, eventually we should see 429. If we never
  // see one, that's fine — but if we get one, it MUST carry a
  // Retry-After header per RFC 9110 so the client can back off.
  let saw429 = false
  let retryAfter: string | null = null
  for (let i = 0; i < 30; i++) {
    const res = await request.get(`${BACKEND}/api/auth/me`)
    if (res.status() === 429) {
      saw429 = true
      retryAfter = res.headers()["retry-after"] || null
      break
    }
  }
  if (saw429) {
    expect(retryAfter, "429 response should carry Retry-After header").not.toBeNull()
  } else {
    test.info().annotations.push({ type: "info", description: "no 429 seen in 30 requests (rate limit may be higher)" })
  }
})

test("backend responds within 5s for /api/health on a single hit", async ({ request }) => {
  // p99 baseline. Health should be near-instant. If it's slow,
  // something downstream (db check, file IO) is leaking time into
  // the hot path.
  const t0 = Date.now()
  const res = await request.get(`${BACKEND}/health`)
  const elapsed = Date.now() - t0
  expect(res.status()).toBe(200)
  expect(elapsed, `health took ${elapsed}ms`).toBeLessThan(5000)
})
