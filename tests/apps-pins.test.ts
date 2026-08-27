import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  MAX_PINS,
  canAddPin,
  canPinApp,
  deriveChipStatus,
  filterAndRankApps,
  normalizeSearch,
  rankApp,
  togglePin,
} from "../lib/apps-pins"

describe("normalizeSearch", () => {
  it("lowercases, strips accents and collapses whitespace", () => {
    assert.equal(normalizeSearch("  GitHub  "), "github")
    assert.equal(normalizeSearch("LinkedIn"), "linkedin")
    assert.equal(normalizeSearch("   Ídeas  Únicas "), "ideas unicas")
  })
})

describe("rankApp", () => {
  const apps = [
    { id: "github", handle: "@GitHub", name: "GitHub", aliases: ["gh", "git hub"], description: "Code, repos and collaboration", category: "Otros" },
    { id: "linkedin", handle: "@LinkedIn", name: "LinkedIn", aliases: ["li"], description: "Find the right professional", category: "Empleo" },
    { id: "etsy", handle: "@Etsy", name: "Etsy", aliases: [], description: "Shop Home, Style & More", category: "Compras" },
  ]

  it("exact handle/id match wins", () => {
    assert.equal(rankApp(apps[0], "github"), 100)
    assert.equal(rankApp(apps[0], "@GitHub"), 100)
    assert.equal(rankApp(apps[1], "linkedin"), 100)
  })

  it("name prefix beats substring", () => {
    assert.ok(rankApp(apps[0], "git") > rankApp(apps[0], "hub"))
    assert.equal(rankApp(apps[0], "git"), 80)
  })

  it("aliases are searched", () => {
    assert.equal(rankApp(apps[0], "gh"), 70)
  })

  it("returns -1 when nothing matches", () => {
    assert.equal(rankApp(apps[2], "zzzz"), -1)
  })
})

describe("filterAndRankApps", () => {
  it("keeps order by rank and drops non-matches", () => {
    const apps = [
      { id: "github", name: "GitHub", description: "Code, repos and collaboration" },
      { id: "gmail", name: "Gmail", description: "Gmail, Calendar and Drive" },
      { id: "x", name: "X", description: "Posts" },
    ]
    const result = filterAndRankApps(apps, "git")
    assert.deepEqual(result.map((app) => app.id), ["github"])
    const gmail = filterAndRankApps(apps, "gma")
    assert.deepEqual(gmail.map((app) => app.id), ["gmail"])
  })

  it("empty query returns everything", () => {
    const apps = [{ id: "a", name: "A" }, { id: "b", name: "B" }]
    assert.equal(filterAndRankApps(apps, "").length, 2)
  })
})

describe("canPinApp", () => {
  it("only available + connected apps can be pinned", () => {
    assert.equal(canPinApp({ appId: "github", connectionStatus: "connected" }), true)
    assert.equal(canPinApp({ appId: "github", connectionStatus: "expired" }), false)
    assert.equal(canPinApp({ appId: "github", connectionStatus: null }), false)
    assert.equal(canPinApp({ appId: "etsy", availability: "unavailable", connectionStatus: "connected" }), false)
    assert.equal(canPinApp({ appId: "github", connecting: true, connectionStatus: "connected" }), false)
  })
})

describe("deriveChipStatus", () => {
  it("active when connected and available", () => {
    assert.equal(deriveChipStatus({ appId: "github", connectionStatus: "connected" }), "active")
  })

  it("loading while connecting", () => {
    assert.equal(deriveChipStatus({ appId: "github", connecting: true }), "loading")
  })

  it("warning when expiring soon", () => {
    const soon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    assert.equal(
      deriveChipStatus({ appId: "github", connectionStatus: "connected", expiresAt: soon }),
      "warning",
    )
  })

  it("blocked when expired/revoked/error/unavailable", () => {
    assert.equal(deriveChipStatus({ appId: "github", connectionStatus: "expired" }), "blocked")
    assert.equal(deriveChipStatus({ appId: "github", connectionStatus: "revoked" }), "blocked")
    assert.equal(deriveChipStatus({ appId: "github", connectionStatus: "error" }), "blocked")
    assert.equal(
      deriveChipStatus({ appId: "etsy", availability: "unavailable", connectionStatus: "connected" }),
      "blocked",
    )
  })
})

describe("pin guards", () => {
  it("max 4 pins", () => {
    assert.equal(MAX_PINS, 4)
    assert.equal(canAddPin(["a", "b", "c"]), true)
    assert.equal(canAddPin(["a", "b", "c", "d"]), false)
  })

  it("togglePin adds and removes without duplicates", () => {
    const added = togglePin(["a", "b"], "c")
    assert.deepEqual(added, { pins: ["a", "b", "c"], added: true })
    const removed = togglePin(["a", "b"], "a")
    assert.deepEqual(removed, { pins: ["b"], added: false })
  })

  it("togglePin refuses beyond the limit", () => {
    assert.equal(togglePin(["a", "b", "c", "d"], "e"), null)
  })
})
