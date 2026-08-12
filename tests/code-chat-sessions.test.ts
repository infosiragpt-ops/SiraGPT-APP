import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"

import {
  codeChatSessionMatchesDepartment,
  codexWorkspaceSessionKey,
  createCodeChatSession,
  deriveCodeChatSessionTitle,
  ensureDefaultSession,
  findCodeChatSessionForDepartment,
  listSessionsForWorkspace,
  readCodeChatStore,
  setActiveCodeChatSession,
  updateCodeChatSessionDepartment,
  updateCodeChatSessionTurns,
} from "../lib/code-chat-sessions"

describe("code-chat-sessions", () => {
  const storage = new Map<string, string>()
  let storageWrites = 0

  beforeEach(() => {
    storage.clear()
    storageWrites = 0
    ;(globalThis as { localStorage: Storage }).localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storageWrites += 1
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

  it("retains all 14 department sessions plus CEO and ordinary chats", () => {
    let store = ensureDefaultSession("local:full-company")
    const departmentIds = Array.from({ length: 14 }, (_, index) => `department-${index + 1}`)
    for (const id of departmentIds) {
      store = createCodeChatSession(
        "local:full-company",
        { title: `Departamento ${id}`, id },
        store,
      ).store
    }
    for (let index = 1; index <= 4; index += 1) {
      store = createCodeChatSession(
        "local:full-company",
        { title: `Conversación ${index}`, id: `ordinary-${index}` },
        store,
      ).store
    }

    const sessions = listSessionsForWorkspace("local:full-company", store)
    assert.equal(sessions.length, 19)
    for (const id of departmentIds) {
      assert.ok(sessions.some((session) => session.id === id), `${id} must remain available`)
    }
    assert.ok(sessions.some((session) => session.title === "CEO Office"))
    assert.equal(sessions.filter((session) => session.id.startsWith("ordinary-")).length, 4)
  })

  it("persists durable department and pool attribution independently of the title", () => {
    let store = ensureDefaultSession("local:attribution")
    const created = createCodeChatSession("local:attribution", {
      title: "Equipo Comercial",
      id: "sales-session",
      departmentId: "sales",
      departmentPoolId: "pool-sales",
    }, store)
    store = created.store
    assert.equal(created.session.departmentId, "sales")
    assert.equal(created.session.departmentPoolId, "pool-sales")

    store = updateCodeChatSessionDepartment("sales-session", {
      departmentId: "customer-success",
      departmentPoolId: "pool-support",
    }, store)
    const assigned = store.sessions.find((session) => session.id === "sales-session")
    assert.equal(assigned?.title, "Equipo Comercial")
    assert.equal(assigned?.departmentId, "customer-success")
    assert.equal(assigned?.departmentPoolId, "pool-support")
  })

  it("does not mutate, persist, timestamp or notify when department identity already matches", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let notificationsScheduled = 0
    let notificationsDispatched = 0
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: () => {
          notificationsScheduled += 1
          return 1
        },
        dispatchEvent: () => {
          notificationsDispatched += 1
          return true
        },
      },
    })

    try {
      let store = ensureDefaultSession("local:idempotent-department")
      const created = createCodeChatSession("local:idempotent-department", {
        title: "Ventas",
        id: "sales-idempotent",
        departmentId: "sales",
        departmentPoolId: "pool-sales",
      }, store)
      store = created.store
      const beforeSession = store.sessions.find((session) => session.id === "sales-idempotent")
      assert.ok(beforeSession)

      storageWrites = 0
      notificationsScheduled = 0
      notificationsDispatched = 0
      const result = updateCodeChatSessionDepartment("sales-idempotent", {
        departmentId: " sales ",
        departmentPoolId: " pool-sales ",
      }, store)

      assert.equal(result, store, "the no-op must preserve store identity")
      assert.equal(
        result.sessions.find((session) => session.id === "sales-idempotent"),
        beforeSession,
        "the no-op must preserve session identity and updatedAt",
      )
      assert.equal(storageWrites, 0)
      assert.equal(notificationsScheduled, 0)
      assert.equal(notificationsDispatched, 0)

      const missing = updateCodeChatSessionDepartment("missing-session", {
        departmentId: "sales",
        departmentPoolId: "pool-sales",
      }, store)
      assert.equal(missing, store)
      assert.equal(storageWrites, 0)
      assert.equal(notificationsScheduled, 0)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("preserves a durable pool during slow hydration and reconciles the confirmed pool later", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let notificationsScheduled = 0
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: () => {
          notificationsScheduled += 1
          return 1
        },
        dispatchEvent: () => true,
      },
    })

    try {
      const workspaceId = "local:slow-pool-hydration"
      let store = ensureDefaultSession(workspaceId)
      store = createCodeChatSession(workspaceId, {
        title: "Ventas",
        id: "sales-with-durable-pool",
        departmentId: "sales",
        departmentPoolId: "pool-sales-durable",
      }, store).store
      const before = store.sessions.find((session) => session.id === "sales-with-durable-pool")
      assert.ok(before)

      storageWrites = 0
      notificationsScheduled = 0
      const whilePoolsAreEmpty = updateCodeChatSessionDepartment(
        "sales-with-durable-pool",
        { departmentId: "sales", departmentPoolId: undefined },
        store,
      )

      assert.equal(whilePoolsAreEmpty, store)
      assert.equal(
        whilePoolsAreEmpty.sessions.find((session) => session.id === "sales-with-durable-pool"),
        before,
      )
      assert.equal(before.departmentPoolId, "pool-sales-durable")
      assert.equal(
        codeChatSessionMatchesDepartment(before, { departmentId: "sales" }),
        true,
        "readiness must treat a not-yet-hydrated pool as a preserve wildcard",
      )
      assert.equal(storageWrites, 0)
      assert.equal(notificationsScheduled, 0)

      const afterHydration = updateCodeChatSessionDepartment(
        "sales-with-durable-pool",
        { departmentId: "sales", departmentPoolId: "pool-sales-confirmed" },
        whilePoolsAreEmpty,
      )
      const hydratedSession = afterHydration.sessions.find(
        (session) => session.id === "sales-with-durable-pool",
      )
      assert.notEqual(afterHydration, whilePoolsAreEmpty)
      assert.equal(hydratedSession?.departmentPoolId, "pool-sales-confirmed")
      assert.equal(storageWrites, 1)
      assert.equal(notificationsScheduled, 1)

      storageWrites = 0
      notificationsScheduled = 0
      const repeatedHydration = updateCodeChatSessionDepartment(
        "sales-with-durable-pool",
        { departmentId: "sales", departmentPoolId: "pool-sales-confirmed" },
        afterHydration,
      )
      assert.equal(repeatedHydration, afterHydration)
      assert.equal(storageWrites, 0)
      assert.equal(notificationsScheduled, 0)

      const explicitlyCleared = updateCodeChatSessionDepartment(
        "sales-with-durable-pool",
        { departmentId: "sales", departmentPoolId: null },
        repeatedHydration,
      )
      assert.equal(
        explicitlyCleared.sessions.find((session) => session.id === "sales-with-durable-pool")?.departmentPoolId,
        undefined,
      )
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("repeating the full 54-department bootstrap neither evicts seats nor rewrites the store", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    let notificationsScheduled = 0
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        setTimeout: () => {
          notificationsScheduled += 1
          return 1
        },
        dispatchEvent: () => true,
      },
    })

    try {
      const workspaceId = "local:full-idempotent-company"
      const seats = [
        { departmentId: "ceo-office", title: "CEO Office", departmentPoolId: "pool-ceo" },
        ...Array.from({ length: 13 }, (_, index) => ({
          departmentId: `builtin-${index + 1}`,
          title: `Departamento base ${index + 1}`,
          departmentPoolId: `pool-builtin-${index + 1}`,
        })),
        ...Array.from({ length: 40 }, (_, index) => ({
          departmentId: `custom-${index + 1}`,
          title: `Departamento personalizado ${index + 1}`,
          departmentPoolId: `pool-custom-${index + 1}`,
        })),
      ]
      const reconcile = (current: ReturnType<typeof ensureDefaultSession>) => {
        let next = current
        for (const seat of seats) {
          const existing = findCodeChatSessionForDepartment(
            listSessionsForWorkspace(workspaceId, next),
            seat.departmentId,
            seat.title,
          )
          if (existing) {
            next = updateCodeChatSessionDepartment(existing.id, seat, next)
            continue
          }
          next = createCodeChatSession(workspaceId, seat, next).store
        }
        return next
      }

      // Fill substantial ordinary history before provisioning the complete
      // backend-supported company. Once the 96-session bound is reached, only
      // ordinary history may be evicted; all 54 runtime seats must remain.
      let initial = ensureDefaultSession(workspaceId)
      for (let index = 1; index <= 60; index += 1) {
        initial = createCodeChatSession(workspaceId, {
          title: `Conversación ordinaria ${index}`,
          id: `ordinary-before-bootstrap-${index}`,
        }, initial).store
      }
      const bootstrapped = reconcile(initial)
      const sessions = listSessionsForWorkspace(workspaceId, bootstrapped)
      assert.equal(seats.length, 54)
      assert.equal(sessions.length, 96)
      assert.ok(seats.every((seat) => {
        const session = findCodeChatSessionForDepartment(sessions, seat.departmentId, seat.title)
        return Boolean(session && codeChatSessionMatchesDepartment(session, seat))
      }))
      assert.equal(
        sessions.filter((session) => session.id.startsWith("ordinary-before-bootstrap-")).length,
        42,
      )
      const references = new Map(sessions.map((session) => [session.id, session] as const))

      storageWrites = 0
      notificationsScheduled = 0
      const repeated = reconcile(bootstrapped)

      assert.equal(repeated, bootstrapped, "a fully prepared fleet must be a store-level no-op")
      assert.equal(listSessionsForWorkspace(workspaceId, repeated).length, 96)
      assert.ok(repeated.sessions.every((session) => references.get(session.id) === session))
      assert.equal(storageWrites, 0)
      assert.equal(notificationsScheduled, 0)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
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
