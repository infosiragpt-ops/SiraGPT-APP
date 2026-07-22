import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  agentCompanyDisplayName,
  buildAgentCompanySnapshot,
  codeSessionStatus,
  departmentIdForSession,
} from "../lib/code-agent-company"
import type { CodeChatSession } from "../lib/code-chat-sessions"

function session(overrides: Partial<CodeChatSession> = {}): CodeChatSession {
  return {
    id: "session-1",
    workspaceId: "workspace-1",
    title: "Agente 1",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
    agent: { phase: "idle", intakeStep: 0, context: { goal: "app" } },
    ...overrides,
  }
}

describe("code agent company", () => {
  it("normalizes company labels without exposing generic project names", () => {
    assert.equal(agentCompanyDisplayName("Nueva app full-stack"), "SiraGPT.COM")
    assert.equal(agentCompanyDisplayName("Sira GPT"), "SiraGPT.COM")
    assert.equal(agentCompanyDisplayName("tesis20"), "TESIS20.COM")
    assert.equal(agentCompanyDisplayName("nexora"), "NEXORA.COM")
  })

  it("derives real operational totals from sessions and workspace files", () => {
    const root = session({ id: "root", createdAt: 10, updatedAt: 20 })
    const worker = session({
      id: "worker",
      createdAt: 11,
      updatedAt: 30,
      agent: { phase: "generating", intakeStep: 0, context: { goal: "app" } },
    })
    const snapshot = buildAgentCompanySnapshot([worker, root], {
      "src/app.tsx": { content: "export default function App() {}" },
      "package.json": {
        content: JSON.stringify({
          dependencies: { react: "1", zod: "1" },
          devDependencies: { typescript: "1", zod: "2" },
        }),
      },
    })

    assert.equal(snapshot.rootSessionId, "root")
    assert.equal(snapshot.activeAgents, 1)
    assert.equal(snapshot.taskCount, 1)
    assert.equal(snapshot.fileCount, 2)
    assert.equal(snapshot.resourceCount, 3)
    assert.equal(snapshot.latestActivityAt, 30)

    assert.equal(buildAgentCompanySnapshot([root], {}).taskCount, 0)
    assert.equal(
      buildAgentCompanySnapshot([
        session({
          id: "root-with-work",
          turns: [{ id: "u1", role: "user", content: "Define el roadmap" }],
        }),
      ], {}).taskCount,
      1,
    )
  })

  it("routes the root to CEO Office and specialized work to departments", () => {
    const root = session({ id: "root", title: "Agente 1" })
    const security = session({
      id: "security",
      title: "Revisión de privacidad y permisos",
      turns: [{ id: "u1", role: "user", content: "Audita seguridad del sandbox" }],
    })
    const product = session({ id: "product", title: "Ajustar componente" })

    assert.equal(departmentIdForSession(root, "root"), "ceo-office")
    assert.equal(departmentIdForSession(security, "root"), "trust")
    assert.equal(departmentIdForSession(product, "root"), "product-engineering")
  })

  it("reports streaming and completed phases honestly", () => {
    assert.deepEqual(
      codeSessionStatus(session({ turns: [{ id: "a", role: "assistant", content: "", streaming: true }] })),
      { label: "Trabajando", tone: "active" },
    )
    assert.deepEqual(
      codeSessionStatus(session({ agent: { phase: "preview", intakeStep: 0, context: { goal: "app" } } })),
      { label: "Listo para verificar", tone: "ready" },
    )
  })
})
