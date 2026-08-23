import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { CodeMobileGrokHeader } from "@/components/code/code-mobile-grok-chrome"

describe("CodeMobileGrokHeader", () => {
  it("shows the circular back, agent pill, online dot, and computer button", () => {
    const onBack = vi.fn()
    const onOpenComputer = vi.fn()
    const onOpenAgentMenu = vi.fn()

    render(
      <CodeMobileGrokHeader
        agentName="Prueba"
        onBack={onBack}
        onOpenComputer={onOpenComputer}
        onOpenAgentMenu={onOpenAgentMenu}
      />,
    )

    expect(screen.getByTestId("code-mobile-grok-header")).toBeInTheDocument()
    expect(screen.getByTestId("code-mobile-grok-agent-name")).toHaveTextContent("Prueba")
    expect(screen.getByTestId("code-mobile-grok-online")).toHaveAttribute("aria-label", "En línea")

    fireEvent.click(screen.getByTestId("code-mobile-grok-back"))
    fireEvent.click(screen.getByTestId("code-mobile-grok-computer"))
    fireEvent.click(screen.getByTestId("code-mobile-grok-agent-pill"))

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onOpenComputer).toHaveBeenCalledTimes(1)
    expect(onOpenAgentMenu).toHaveBeenCalledTimes(1)
  })
})
