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
})

describe("needsSidebar", () => {
  it("opts /admin out: it owns its own layout (AdminLayout) — the global AppShell would mount AppSidebar, which calls useChat() and crashes outside a ChatProvider", () => {
    assert.equal(needsSidebar("/admin/security"), false)
  })

  it("enables the sidebar on library pages", () => {
    assert.equal(needsSidebar("/library"), true)
  })

  it("enables the sidebar on Codex pages", () => {
    assert.equal(needsSidebar("/codex"), true)
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
