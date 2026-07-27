import { describe, expect, it } from "vitest"

import { CODEX_SLASH_COMMANDS, expandCodexSlashCommand } from "@/lib/codex/slash-commands"

describe("Codex slash commands", () => {
  it("expands supported commands with arguments", () => {
    const result = expandCodexSlashCommand("/test solo frontend")
    expect(result.command?.name).toBe("test")
    expect(result.prompt).toContain("COMANDO /test")
    expect(result.prompt).toContain("solo frontend")
  })

  it("keeps ordinary and unknown prompts unchanged", () => {
    expect(expandCodexSlashCommand("crea una app").prompt).toBe("crea una app")
    expect(expandCodexSlashCommand("/custom value").prompt).toBe("/custom value")
  })

  it("registers deploy, test, and review", () => {
    expect(CODEX_SLASH_COMMANDS.map((row) => row.name)).toEqual(["test", "review", "deploy"])
  })
})
