import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { AgenticStepsRenderer } from "@/components/agentic-steps"
import {
  initialAgentState,
  type AgentArtifact,
  type AgentTaskState,
} from "@/lib/agent-task-service"

afterEach(cleanup)

function artifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    id: "artifact-1",
    filename: "Modelo Informe editado.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    sizeBytes: 12_000,
    downloadUrl: "/api/artifacts/artifact-1",
    ...overrides,
  }
}

function completedState(artifacts: AgentArtifact[]): AgentTaskState {
  return {
    ...initialAgentState,
    steps: [],
    artifacts,
    approvals: [],
    checkpoints: [],
    qualityGates: [],
    repairs: [],
    done: true,
  }
}

describe("AgenticStepsRenderer · artifact cards", () => {
  it("shows the real filename and exposes a stable card selector", () => {
    render(<AgenticStepsRenderer state={completedState([artifact()])} />)

    const card = screen.getByTestId("agent-artifact-card")
    expect(card).toHaveAttribute("data-artifact-id", "artifact-1")
    expect(card).toHaveAccessibleName("Archivo: Modelo Informe editado.docx")
    expect(screen.getByText("Modelo Informe editado.docx")).toBeTruthy()
    expect(screen.queryByText("Documento Word")).toBeNull()
  })

  it("names each document action with its artifact filename", () => {
    render(<AgenticStepsRenderer state={completedState([
      artifact({ id: "artifact-1", sourceFileId: "source-1" }),
      artifact({
        id: "artifact-2",
        sourceFileId: "source-2",
        filename: "Contrato editado.docx",
        downloadUrl: "/api/artifacts/artifact-2",
      }),
    ])} />)

    expect(screen.getByRole("button", { name: "Descargar documento: Modelo Informe editado.docx" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Ver documento: Contrato editado.docx" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Historial de versiones: Contrato editado.docx" })).toBeTruthy()
  })

  it.each([
    { passed: true },
    { passed: true, ok: false },
    { passed: true, ok: true },
  ])("shows Validado only for an explicit passed result: %j", (validation) => {
    render(<AgenticStepsRenderer state={completedState([artifact({ validation })])} />)

    expect(screen.getByText("Validado")).toBeTruthy()
  })

  it.each([
    undefined,
    null,
    { passed: false },
    { ok: false },
    { passed: false, ok: false },
    { passed: false, ok: true },
    { ok: true },
  ])("does not claim validation without a positive result: %j", (validation) => {
    render(<AgenticStepsRenderer state={completedState([artifact({ validation })])} />)

    expect(screen.queryByText("Validado")).toBeNull()
  })

  it("keeps the filename visible in the mobile card layout", () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    window.dispatchEvent(new Event("resize"))

    try {
      render(<AgenticStepsRenderer state={completedState([artifact()])} />)

      const filename = screen.getByTestId("agent-artifact-filename")
      expect(filename).toHaveTextContent("Modelo Informe editado.docx")
      expect(filename.className.split(/\s+/)).not.toContain("hidden")
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth })
      window.dispatchEvent(new Event("resize"))
    }
  })
})
