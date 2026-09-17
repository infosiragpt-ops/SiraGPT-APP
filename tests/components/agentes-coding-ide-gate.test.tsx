import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { AgentesCodingIdeGate } from "@/components/agentes/coding-ide-gate"
import { agentesCodingApi } from "@/lib/agentes-coding/api"

vi.mock("@/lib/agentes-coding/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agentes-coding/api")>(
    "@/lib/agentes-coding/api",
  )
  return {
    ...actual,
    agentesCodingApi: {
      ...actual.agentesCodingApi,
      health: vi.fn(),
    },
  }
})

vi.mock("next/dynamic", () => ({
  default: () => function CodingIdeShellStub() {
    return <div data-testid="agentes-coding-ide">Editor de código</div>
  },
}))

describe("AgentesCodingIdeGate", () => {
  beforeEach(() => {
    vi.mocked(agentesCodingApi.health).mockReset()
  })

  it("renders nothing when health.enabled is false (default)", async () => {
    vi.mocked(agentesCodingApi.health).mockResolvedValue({ ok: true, enabled: false })
    const { container } = render(<AgentesCodingIdeGate />)
    await waitFor(() => {
      expect(agentesCodingApi.health).toHaveBeenCalled()
    })
    expect(screen.queryByTestId("agentes-coding-ide")).toBeNull()
    expect(container).toBeEmptyDOMElement()
  })

  it("mounts the IDE shell only after health.enabled is true", async () => {
    vi.mocked(agentesCodingApi.health).mockResolvedValue({ ok: true, enabled: true })
    render(<AgentesCodingIdeGate />)
    expect(await screen.findByTestId("agentes-coding-ide")).toHaveTextContent("Editor de código")
  })
})
