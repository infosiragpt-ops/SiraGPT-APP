import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"

import {
  codexWorkspaceSessionKey,
  createCodeChatSession,
  deriveCodeChatSessionTitle,
  ensureDefaultSession,
  listSessionsForWorkspace,
  readCodeChatStore,
  setActiveCodeChatSession,
  updateCodeChatSessionTurns,
} from "../lib/code-chat-sessions"

describe("code-chat-sessions", () => {
  const storage = new Map<string, string>()

  beforeEach(() => {
    storage.clear()
    ;(globalThis as { localStorage: Storage }).localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value)
      },
      removeItem: (key) => {
        storage.delete(key)
      },
      clear: () => {
        storage.clear()
      },
      key: () => null,
      length: 0,
    } as Storage
  })

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage
  })

  it("creates default and parallel sessions per workspace", () => {
    let store = ensureDefaultSession("local:siragpt")
    assert.equal(listSessionsForWorkspace("local:siragpt", store).length, 1)

    const created = createCodeChatSession("local:siragpt", undefined, store)
    store = created.store
    assert.equal(listSessionsForWorkspace("local:siragpt", store).length, 2)
    assert.equal(store.activeByWorkspace["local:siragpt"], created.session.id)
  })

  it("switches active session", () => {
    let store = ensureDefaultSession("ws-a")
    const second = createCodeChatSession("ws-a", { title: "Segundo" }, store)
    store = second.store
    const firstId = listSessionsForWorkspace("ws-a", store)[1]?.id
    assert.ok(firstId)
    store = setActiveCodeChatSession("ws-a", firstId!, store)
    assert.equal(store.activeByWorkspace["ws-a"], firstId)
  })

  it("normalizes bare project UUID to project: prefix for sessions", () => {
    storage.set(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions: [
          {
            id: "s1",
            workspaceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            title: "Agente 1",
            turns: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        activeByWorkspace: {},
      }),
    )
    const store = readCodeChatStore()
    const key = codexWorkspaceSessionKey("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    assert.equal(key, "project:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    assert.equal(listSessionsForWorkspace(key, store).length, 1)
  })

  it("names parallel sessions Agente N", () => {
    let store = ensureDefaultSession("local:tesis20")
    assert.equal(listSessionsForWorkspace("local:tesis20", store)[0]?.title, "Agente 1")
    const second = createCodeChatSession("local:tesis20", undefined, store)
    assert.equal(second.session.title, "Agente 2")
  })

  it("derives title from first user message", () => {
    assert.equal(
      deriveCodeChatSessionTitle([{ id: "1", role: "user", content: "dame la web en local" }]),
      "dame la web en local",
    )
    let store = ensureDefaultSession("ws-b")
    const sessionId = store.activeByWorkspace["ws-b"]
    assert.ok(sessionId)
    store = updateCodeChatSessionTurns(
      sessionId!,
      () => [{ id: "u1", role: "user", content: "Greeting in Spanish" }],
      store,
    )
    const session = store.sessions.find((s) => s.id === sessionId)
    assert.equal(session?.title, "Greeting in Spanish")
  })
})
