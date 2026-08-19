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
    assert.equal(second.session.titleLocked, true)
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
    // The migration must rewrite the persisted session's workspaceId too.
    assert.equal(store.sessions[0]?.workspaceId, key)
    // RFC-4122 v4 ids normalize as well; already-canonical / non-id values pass through.
    assert.equal(
      codexWorkspaceSessionKey("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
      "project:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    )
    assert.equal(
      codexWorkspaceSessionKey("cmj5q0v7x0001l2abc3def456"),
      "project:cmj5q0v7x0001l2abc3def456",
    )
    assert.equal(codexWorkspaceSessionKey(key), key)
    assert.equal(codexWorkspaceSessionKey("local:siragpt"), "local:siragpt")
    assert.equal(codexWorkspaceSessionKey("not-a-uuid"), "not-a-uuid")
    assert.equal(codexWorkspaceSessionKey(""), "__default__")
  })

  it("names the executive entry point and parallel sessions Agente N", () => {
    let store = ensureDefaultSession("local:tesis20")
    assert.equal(listSessionsForWorkspace("local:tesis20", store)[0]?.title, "CEO Office")
    const second = createCodeChatSession("local:tesis20", undefined, store)
    assert.equal(second.session.title, "Agente 2")
  })

  it("migrates only untouched legacy Agente 1 sessions", () => {
    storage.set(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions: [
          {
            id: "empty",
            workspaceId: "local:legacy",
            title: "Agente 1",
            turns: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "used",
            workspaceId: "local:legacy",
            title: "Agente 1",
            turns: [{ id: "u1", role: "user", content: "Construye un CRM" }],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
        activeByWorkspace: { "local:legacy": "empty" },
      }),
    )

    const sessions = listSessionsForWorkspace("local:legacy", readCodeChatStore())
    assert.equal(sessions.find((session) => session.id === "empty")?.title, "CEO Office")
    assert.equal(sessions.find((session) => session.id === "used")?.title, "Agente 1")
  })

  it("accepts caller-generated ids for atomic parallel creation", () => {
    let store = ensureDefaultSession("local:company")
    const ceo = createCodeChatSession("local:company", { title: "CEO Office", id: "ceo-id" }, store)
    store = ceo.store
    const engineering = createCodeChatSession(
      "local:company",
      { title: "Producto e Ingeniería SiraGPT", id: "engineering-id" },
      store,
    )
    const ids = listSessionsForWorkspace("local:company", engineering.store).map((session) => session.id)
    assert.ok(ids.includes("ceo-id"))
    assert.ok(ids.includes("engineering-id"))
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

  it("preserves the durable run id needed to reconcile cancellation after reload", () => {
    storage.set(
      "code-workspace:agent-sessions:v1",
      JSON.stringify({
        sessions: [{
          id: "cancel-session",
          workspaceId: "local:cancel",
          title: "CEO Office",
          turns: [{
            id: "assistant-cancel",
            role: "assistant",
            content: "Trabajo parcial",
            streaming: true,
            codexRunId: "run-cancelled",
            cancellationState: "cancelling",
          }],
          createdAt: 1,
          updatedAt: 2,
        }],
        activeByWorkspace: { "local:cancel": "cancel-session" },
      }),
    )

    const restored = readCodeChatStore().sessions[0]?.turns[0]
    assert.equal(restored?.codexRunId, "run-cancelled")
    assert.equal(restored?.cancellationState, "cancelling")
  })
})
