import assert from "node:assert/strict"
import { describe, it } from "node:test"
import fs from "node:fs"
import path from "node:path"

const sidebarPath = path.join(process.cwd(), "components", "app-sidebar.tsx")
const source = fs.readFileSync(sidebarPath, "utf8")

describe("app sidebar single recent-chats collapse source contract", () => {
  it("persists one collapsed state for the whole recent-chats section", () => {
    assert.match(source, /sira:sidebar:recent-collapsed/,
      "recent-chats collapse state must be persisted under its own key")
    assert.match(source, /recentChatsCollapsed/,
      "component should keep a single collapsed state for the recent-chats section")
    assert.match(source, /toggleRecentChatsCollapsed/,
      "component should expose one toggle handler for the recent-chats section")
  })

  it("exposes the collapse control on the Recent chats header with accessible wiring", () => {
    assert.match(source, /aria-expanded=\{!recentChatsCollapsed\}/,
      "the section header must disclose its expanded state")
    assert.match(source, /aria-controls="sidebar-recent-chats-content"/,
      "the header must point to the controlled recent-chats region")
    assert.match(source, /id="sidebar-recent-chats-content"/,
      "the recent-chats content region needs a stable controlled id")
  })

  it("no longer collapses individual date buckets", () => {
    assert.doesNotMatch(source, /toggleChatGroupCollapsed/,
      "per-date-group collapse handlers should be gone")
    assert.doesNotMatch(source, /collapsedChatGroups/,
      "per-date-group collapse state should be gone")
    assert.doesNotMatch(source, /sira:sidebar:chat-groups-collapsed/,
      "the per-group storage key should be removed")
  })
})
