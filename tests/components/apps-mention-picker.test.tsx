import { render, screen, within } from "@testing-library/react"
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

const x: MentionPickerApp = {
  id: "x",
  name: "X",
  description: "Posts and public conversation",
  domain: "x.com",
  status: "connect",
  healthStatus: null,
  logo: "/conexiones-logos/x.svg",
  logoSources: ["/conexiones-logos/x.svg"],
}

const facebook: MentionPickerApp = {
  id: "facebook",
  name: "Facebook",
  description: "Pages and social publishing",
  domain: "facebook.com",
  status: "connect",
  healthStatus: null,
  logo: "/conexiones-logos/facebook.svg",
  logoSources: ["/conexiones-logos/facebook.svg"],
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

function expectOfficialLogoRow(
  id: string,
  src: string,
  statusLabel: string,
) {
  const row = screen.getByTestId(`apps-mention-option-${id}`)
  const logo = within(row).getByTestId(`apps-mention-logo-${id}`)
  expect(logo).toHaveAttribute("src", src)
  expect(logo.tagName).toBe("IMG")
  expect(within(row).getByText(statusLabel)).toBeInTheDocument()
}

describe("AppsMentionPicker logos", () => {
  it("renders official catalog logo srcs and keeps status as a label", () => {
    render(
      <AppsMentionPicker
        open
        filter=""
        apps={[github, linkedin, x, facebook]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expectOfficialLogoRow("github", "/conexiones-logos/github.svg", "Conectada")
    expectOfficialLogoRow("linkedin", "/conexiones-logos/linkedin.svg", "Conectar")
    expectOfficialLogoRow("x", "/conexiones-logos/x.svg", "Conectar")
    expectOfficialLogoRow("facebook", "/conexiones-logos/facebook.svg", "Conectar")
    expect(screen.getByTestId("apps-mention-logo-github")).toHaveAttribute("alt", "GitHub logo")
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

    const row = screen.getByTestId("apps-mention-option-obscure-demo")
    expect(within(row).queryByTestId("apps-mention-logo-obscure-demo")).toBeNull()
    expect(within(row).getByText("No disponible todavía")).toBeInTheDocument()
  })
})
