import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  deserializeSidebarFolderState,
  emptySidebarFolderState,
  isSidebarFolderSnapshot,
  importLegacyFolderNames,
  migrateLegacySidebarFolders,
  normalizeSidebarFolderState,
  serializeSidebarFolderState,
  sidebarFolderCacheKey,
  withoutSidebarFolderSettings,
} from "../lib/sidebar-folder-state"

describe("account folder settings", () => {
  it("round-trips folders, pinning, descriptions, unread chats and sections", () => {
    const state = normalizeSidebarFolderState({
      names: [" Trabajo ", "trabajo", "Personal"],
      assignments: { c1: "TRABAJO", c2: "Personal" },
      metadata: { TRABAJO: { isPinned: true, description: " Proyecto del equipo " } },
      unreadIds: ["c1", "c1"],
      sections: ["Hoy", "hoy"],
      chatSections: { c1: "HOY", c2: "nonexistent" },
    })
    assert.deepEqual(state.names, ["Trabajo", "Personal"])
    assert.deepEqual(state.assignments, { c1: "Trabajo", c2: "Personal" })
    assert.deepEqual(state.chatSections, { c1: "Hoy" })
    assert.deepEqual(state.unreadIds, ["c1"])
    const roundTrip = deserializeSidebarFolderState(serializeSidebarFolderState(state))
    assert.deepEqual(roundTrip.metadata.trabajo, { isPinned: true, description: "Proyecto del equipo" })
    assert.deepEqual(roundTrip.assignments, state.assignments)
    assert.deepEqual(roundTrip.chatSections, state.chatSections)
  })

  it("removes all records under the backend's recursive merge contract", () => {
    const old = serializeSidebarFolderState(normalizeSidebarFolderState({
      names: ["Private"], assignments: { oldChat: "Private" },
      metadata: { private: { isPinned: true, description: "Private notes" } },
      unreadIds: ["oldChat"], sections: ["Follow up"], chatSections: { oldChat: "Follow up" },
    }))
    const cleared = serializeSidebarFolderState(emptySidebarFolderState())
    // Every deletable collection is an array and therefore replaced by PUT.
    for (const [key, value] of Object.entries(cleared)) {
      if (key !== "version") assert.ok(Array.isArray(value), key)
    }
    assert.deepEqual(deserializeSidebarFolderState({ ...old, ...cleared }), emptySidebarFolderState())
  })

  it("migrates only chat assignments proven to belong to this account", () => {
    const migrated = migrateLegacySidebarFolders({ owned: "Team", somebodyElse: "Confidential", orphan: "Empty" }, ["owned"])
    assert.deepEqual(migrated.names, ["Team"])
    assert.deepEqual(migrated.assignments, { owned: "Team" })
    assert.deepEqual(migrateLegacySidebarFolders({ old: "Private" }, []), emptySidebarFolderState())
    assert.notEqual(sidebarFolderCacheKey("alice"), sidebarFolderCacheKey("bob"))
  })

  it("rejects dangerous keys and malformed snapshots without prototype mutation", () => {
    const raw = JSON.parse('{"names":["Safe"],"assignments":{"__proto__":"Safe","constructor":"Safe","c1":"Safe"},"metadata":{"__proto__":{"polluted":true},"safe":{"isPinned":"true"}}}')
    const state = normalizeSidebarFolderState(raw)
    assert.deepEqual(state.assignments, { c1: "Safe" })
    assert.equal(state.metadata.safe.isPinned, false)
    assert.equal(({} as { polluted?: boolean }).polluted, undefined)
    assert.equal(isSidebarFolderSnapshot({ version: 2, folders: [], assignments: [] }), false)
    assert.deepEqual(deserializeSidebarFolderState(null), emptySidebarFolderState())
  })

  it("imports empty legacy names only through the explicit name-only action", () => {
    const state = importLegacyFolderNames(emptySidebarFolderState(), ["HOLA", "hola", " Personal "])
    assert.deepEqual(state.names, ["HOLA", "Personal"])
    assert.deepEqual(state.assignments, {})
    assert.deepEqual(state.unreadIds, [])
  })

  it("keeps unrelated settings writes from restoring a stale folder snapshot", () => {
    const stale = { theme: "dark", sidebarChatFolders: { folders: ["deleted"] }, notifications: { email: true } }
    assert.deepEqual(withoutSidebarFolderSettings(stale), { theme: "dark", notifications: { email: true } })
    assert.deepEqual(stale.sidebarChatFolders, { folders: ["deleted"] })
  })
})
