import { expect, test } from "@playwright/test"

/**
 * Duplication guard (DOM level) — "sigue duplicando los mensajes".
 *
 * Each rendered message bubble carries a unique `data-message-id`
 * (components/message-component.tsx). The optimistic-UI reconciliation bug
 * used to leave an optimistic turn AND its server twin both mounted, so the
 * same message appeared twice. `dedupeMessages` now collapses those at both
 * the merge and render layers (see lib/message-preservation.ts +
 * tests/message-dedupe.test.ts for the deterministic unit coverage).
 *
 * This spec is the end-to-end symptom check: whatever messages the /chat
 * surface renders, no two bubbles may share a `data-message-id`. It is
 * intentionally CI-safe — an anonymous visitor may be redirected to auth or
 * land on an empty conversation, in which case there are simply zero bubbles
 * and the invariant holds vacuously. It never sends a message (which would
 * require a seeded user + a live model), so it cannot flake.
 */
test("no two chat bubbles share a data-message-id", async ({ page }) => {
  const response = await page.goto("/chat", { waitUntil: "domcontentloaded", timeout: 60_000 })
  expect(response, "navigation should resolve").not.toBeNull()
  expect(
    response!.ok() || (response!.status() >= 300 && response!.status() < 400),
    `chat route returned ${response!.status()}`,
  ).toBe(true)
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 })

  // Give any client-side hydration / message hydrate a brief, bounded window
  // to mount bubbles, then snapshot the ids. We don't wait for a specific
  // count — zero is a valid (vacuous) state.
  await page.waitForTimeout(1_500)

  const ids = await page.locator("[data-message-id]").evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute("data-message-id")).filter((v): v is string => !!v),
  )

  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i)
  expect(
    duplicates,
    `duplicate message bubbles rendered for ids: ${[...new Set(duplicates)].join(", ")}`,
  ).toEqual([])

  // Sanity: when bubbles DO render, unique-id count equals total count.
  expect(new Set(ids).size).toBe(ids.length)
})
