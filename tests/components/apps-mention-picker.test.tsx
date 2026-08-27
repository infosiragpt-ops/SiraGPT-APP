import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { AppsMentionPicker } from "@/components/AppsMentionPicker"
import type { MentionPickerApp } from "@/lib/apps-mentions"

const github: MentionPickerApp = {
  id: "github",
  name: "GitHub",
  description: "Code, repos and collaboration",
  domain: "github.com",
  status: "connected",
  healthStatus: "connected",
  logo: "/conexiones-logos/github.svg",
  logoSources: ["/conexiones-logos/github.svg"],
}

const linkedin: MentionPickerApp = {
  id: "linkedin",
  name: "LinkedIn",
  description: "Find the right professional",
  domain: "linkedin.com",
  status: "connect",
  healthStatus: null,
  logo: "/conexiones-logos/linkedin.svg",
  logoSources: ["/conexiones-logos/linkedin.svg"],
}

const unknown: MentionPickerApp = {
  id: "obscure-demo",
  name: "Obscure Demo",
  description: "No official mark",
  domain: "steerastro.com",
  status: "unavailable",
  healthStatus: null,
  logo: null,
  logoSources: [],
}

describe("AppsMentionPicker logos", () => {
  it("renders official catalog logo srcs and keeps status as a label", () => {
    render(
      <AppsMentionPicker
        open
        filter=""
        apps={[github, linkedin]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    const githubLogo = screen.getByTestId("apps-mention-logo-github")
    expect(githubLogo).toHaveAttribute("src", "/conexiones-logos/github.svg")
    expect(githubLogo).toHaveAttribute("alt", "GitHub logo")
    expect(screen.getByTestId("apps-mention-logo-linkedin")).toHaveAttribute(
      "src",
      "/conexiones-logos/linkedin.svg",
    )
    expect(screen.getByText("Conectada")).toBeInTheDocument()
    expect(screen.getByText("Conectar")).toBeInTheDocument()
    expect(screen.getByTestId("apps-mention-status-github")).toBeInTheDocument()
  })

  it("falls back to the generic status mark only when there is no official asset", () => {
    render(
      <AppsMentionPicker
        open
        filter=""
        apps={[unknown]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByTestId("apps-mention-logo-obscure-demo")).toBeNull()
    expect(screen.getByTestId("apps-mention-option-obscure-demo")).toBeInTheDocument()
    expect(screen.getByText("No disponible todavía")).toBeInTheDocument()
  })
})
