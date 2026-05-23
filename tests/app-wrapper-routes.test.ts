import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { needsChatContext, needsSidebar } from "../lib/app-wrapper-routes"

describe("needsChatContext", () => {
  it("enables chat context on the chat route", () => {
    assert.equal(needsChatContext("/chat"), true)
  })

  it("enables chat context on nested GPT routes", () => {
    assert.equal(needsChatContext("/gpts/create"), true)
  })

  it("enables chat context on thesis routes", () => {
    assert.equal(needsChatContext("/thesis"), true)
  })

  it("enables chat context on document editor routes", () => {
    assert.equal(needsChatContext("/documents/editor"), true)
  })

  it("disables chat context on the landing page", () => {
    assert.equal(needsChatContext("/"), false)
  })

  it("treats exact-match and trailing-slash forms identically", () => {
    // matchesPrefix is "exact path OR startsWith prefix/" — the
    // trailing slash form must also enable chat context.
    assert.equal(needsChatContext("/chat/"), true)
    assert.equal(needsChatContext("/projects/"), true)
  })

  it("does NOT enable chat context for paths that merely START with a chat prefix string", () => {
    // /chatroom is not a chat page even though it starts with "chat"
    // (the matcher requires "/" or end-of-string after the prefix).
    assert.equal(needsChatContext("/chatroom"), false)
    assert.equal(needsChatContext("/codexish"), false)
  })

  it("enables chat context on every documented prefix", () => {
    for (const path of [
      "/chat", "/gpts", "/parafraseo", "/projects", "/design",
      "/codex", "/code", "/plan", "/profile", "/library",
      "/billing", "/settings", "/thesis", "/documents",
    ]) {
      assert.equal(needsChatContext(path), true, `expected ${path} -> true`)
    }
  })
})

describe("needsSidebar", () => {
  it("opts /admin out: it owns its own layout (AdminLayout) — the global AppShell would mount AppSidebar, which calls useChat() and crashes outside a ChatProvider", () => {
    assert.equal(needsSidebar("/admin/security"), false)
  })

  it("enables the sidebar on library pages", () => {
    assert.equal(needsSidebar("/library"), true)
  })

  it("keeps Codex full-screen while preserving chat context", () => {
    assert.equal(needsSidebar("/codex"), false)
    assert.equal(needsChatContext("/codex"), true)
  })

  it("enables the sidebar on profile pages", () => {
    assert.equal(needsSidebar("/profile"), true)
  })

  it("disables the sidebar on auth pages", () => {
    assert.equal(needsSidebar("/auth/login"), false)
  })

  it("disables the sidebar on the public home page", () => {
    assert.equal(needsSidebar("/"), false)
  })
})
