import { describe, expect, it } from "vitest"

import {
  buildAuthAgentPrompt,
  buildAutomationAgentPrompt,
  detectWorkspaceAuth,
} from "@/lib/code-agent/workspace-auth"

describe("detectWorkspaceAuth", () => {
  it("detects auth libraries in content", () => {
    const state = detectWorkspaceAuth({
      "src/auth.ts": { content: `import NextAuth from "next-auth"` },
    })
    expect(state.hasAuth).toBe(true)
    expect(state.evidence[0]).toMatchObject({ path: "src/auth.ts", hint: "NextAuth / Auth.js" })
  })

  it("detects auth by path (api route, login screens)", () => {
    const state = detectWorkspaceAuth({
      "app/api/auth/route.ts": { content: "export {}" },
      "app/login.tsx": { content: "export default function Login(){return null}" },
    })
    expect(state.hasAuth).toBe(true)
    const hints = state.evidence.map((row) => row.hint)
    expect(hints).toContain("ruta API de auth")
    expect(hints).toContain("pantalla de login/registro")
  })

  it("detects JWT + password forms", () => {
    const state = detectWorkspaceAuth({
      "src/session.ts": { content: `jwt.sign({ id }, secret)` },
      "src/Form.tsx": { content: `<input type="password" />` },
    })
    expect(state.hasAuth).toBe(true)
    expect(state.evidence).toHaveLength(2)
  })

  it("middleware alone is NOT auth", () => {
    const state = detectWorkspaceAuth({
      "middleware.ts": { content: "export function middleware() {}" },
    })
    expect(state.hasAuth).toBe(false)
    expect(state.evidence).toHaveLength(1) // evidence shown, but not conclusive
  })

  it("clean app → no auth, tolerant of bad input", () => {
    expect(detectWorkspaceAuth({ "src/App.tsx": { content: "export default 1" } }).hasAuth).toBe(false)
    expect(detectWorkspaceAuth(null).hasAuth).toBe(false)
    expect(detectWorkspaceAuth({}).evidence).toEqual([])
  })

  it("dedupes repeated hints per file", () => {
    const state = detectWorkspaceAuth({
      "a.ts": { content: "next-auth next-auth next-auth" },
    })
    expect(state.evidence).toHaveLength(1)
  })
})

describe("buildAuthAgentPrompt", () => {
  it("lists selected providers and session length", () => {
    const prompt = buildAuthAgentPrompt({
      email: true,
      google: true,
      github: false,
      requireVerifiedEmail: true,
      sessionDays: 14,
    })
    expect(prompt).toContain("email y contraseña, Google OAuth")
    expect(prompt).not.toContain("GitHub")
    expect(prompt).toContain("14 día(s)")
    expect(prompt).toContain("email verificado")
  })

  it("defaults to email when nothing is selected and clamps days", () => {
    const prompt = buildAuthAgentPrompt({
      email: false,
      google: false,
      github: false,
      requireVerifiedEmail: false,
      sessionDays: 500,
    })
    expect(prompt).toContain("email y contraseña")
    expect(prompt).toContain("90 día(s)")
    expect(prompt).not.toContain("email verificado")
  })
})

describe("buildAutomationAgentPrompt", () => {
  it("wraps the rule label and caps length", () => {
    const prompt = buildAutomationAgentPrompt("Validar antes de publicar")
    expect(prompt).toContain('"Validar antes de publicar"')
    expect(prompt).toContain("resumen")
    const long = buildAutomationAgentPrompt("x".repeat(500))
    expect(long.length).toBeLessThan(500)
  })
})
