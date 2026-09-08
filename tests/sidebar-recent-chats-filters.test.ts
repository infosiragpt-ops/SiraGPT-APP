import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  chatActivityBucket,
  filterRecentChats,
  groupRecentChatsByDate,
  matchesRecentChatQuery,
  sortChatsNewestFirst,
} from "../lib/sidebar-recent-chats-filters"

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 7, 25, 16, 0, 0)

function iso(offsetMs: number) {
  return new Date(NOW + offsetMs).toISOString()
}

describe("sidebar recent-chats filters", () => {
  it("matches titles case-insensitively and ignores blank queries", () => {
    assert.equal(matchesRecentChatQuery("Hola, como estas?", ""), true)
    assert.equal(matchesRecentChatQuery("Hola, como estas?", "hola"), true)
    assert.equal(matchesRecentChatQuery("transcribir", "resumen"), false)
  })

  it("buckets activity with local day boundaries", () => {
    assert.equal(chatActivityBucket(iso(0), NOW), "today")
    assert.equal(chatActivityBucket(iso(-DAY), NOW), "yesterday")
    assert.equal(chatActivityBucket(iso(-3 * DAY), NOW), "last7Days")
    assert.equal(chatActivityBucket(iso(-10 * DAY), NOW), "older")
  })

  it("hides archived and hidden chats in the default Activo status", () => {
    const chats = [
      { id: "live", title: "vivo", updatedAt: iso(0) },
      { id: "arch", title: "archivo", updatedAt: iso(0), isArchived: true },
      { id: "hid", title: "oculto", updatedAt: iso(0) },
    ]
    const visible = filterRecentChats(chats, {
      hiddenIds: ["hid"],
      now: NOW,
    })
    assert.deepEqual(visible.map((chat) => chat.id), ["live"])
  })

  it("filters by scheduled type, archived status, pinned status, and activity", () => {
    const chats = [
      { id: "a", title: "alpha", updatedAt: iso(0), isPinned: true },
      { id: "b", title: "beta", updatedAt: iso(-DAY) },
      { id: "c", title: "gamma", updatedAt: iso(-8 * DAY), isArchived: true },
    ]

    assert.deepEqual(
      filterRecentChats(chats, { type: "scheduled", scheduledIds: { b: { at: iso(0) } }, now: NOW }).map((c) => c.id),
      ["b"],
    )
    assert.deepEqual(
      filterRecentChats(chats, { status: "archived", now: NOW }).map((c) => c.id),
      ["c"],
    )
    assert.deepEqual(
      filterRecentChats(chats, { status: "pinned", now: NOW }).map((c) => c.id),
      ["a"],
    )
    assert.deepEqual(
      filterRecentChats(chats, { activity: "yesterday", now: NOW }).map((c) => c.id),
      ["b"],
    )
    assert.deepEqual(
      filterRecentChats(chats, { query: "gam", status: "archived", now: NOW }).map((c) => c.id),
      ["c"],
    )
  })

  it("groups by date or returns a newest-first flat list", () => {
    const chats = [
      { id: "old", updatedAt: iso(-10 * DAY) },
      { id: "today", updatedAt: iso(0) },
      { id: "yest", updatedAt: iso(-DAY) },
    ]
    const grouped = groupRecentChatsByDate(chats, NOW)
    assert.deepEqual(grouped.today.map((c) => c.id), ["today"])
    assert.deepEqual(grouped.yesterday.map((c) => c.id), ["yest"])
    assert.deepEqual(grouped.older.map((c) => c.id), ["old"])
    assert.deepEqual(sortChatsNewestFirst(chats).map((c) => c.id), ["today", "yest", "old"])
  })
})
