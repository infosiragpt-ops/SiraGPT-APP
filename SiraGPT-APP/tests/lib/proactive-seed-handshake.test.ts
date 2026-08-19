import { beforeEach, describe, expect, it } from "vitest"

import {
  claimPendingSeedPrompt,
  requestProactiveSeedPrompt,
} from "@/lib/code-agent-company-proactive"

// The PROACTIVO kickoff race: the button fires the seed prompt ~120ms after
// opening the CEO chat; if the chat panel hasn't mounted its listener yet the
// kickoff used to vanish and the button looked dead. The handshake stashes an
// unconsumed kickoff so the panel claims it on mount — exactly once.
describe("proactive seed prompt handshake", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it("stashes the kickoff when no listener consumed it, claimable exactly once", () => {
    requestProactiveSeedPrompt("Activa la empresa X")
    expect(claimPendingSeedPrompt()).toBe("Activa la empresa X")
    expect(claimPendingSeedPrompt()).toBeNull()
  })

  it("does NOT stash when a mounted listener marks the event consumed", () => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string; consumed?: boolean }>).detail
      if (detail) detail.consumed = true
    }
    window.addEventListener("siragpt:code-agent-request", handler)
    try {
      requestProactiveSeedPrompt("Activa la empresa Y")
    } finally {
      window.removeEventListener("siragpt:code-agent-request", handler)
    }
    expect(claimPendingSeedPrompt()).toBeNull()
  })

  it("expires a stale stash instead of firing a surprise build later", () => {
    window.sessionStorage.setItem(
      "code-workspace:proactive-pending-seed:v1",
      JSON.stringify({ text: "viejo", ts: Date.now() - 10 * 60_000 }),
    )
    expect(claimPendingSeedPrompt()).toBeNull()
  })

  it("ignores empty prompts and malformed stash entries", () => {
    requestProactiveSeedPrompt("   ")
    expect(claimPendingSeedPrompt()).toBeNull()
    window.sessionStorage.setItem("code-workspace:proactive-pending-seed:v1", "{no json")
    expect(claimPendingSeedPrompt()).toBeNull()
  })
})
