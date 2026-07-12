import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Source-level contract tests for the Enterprise Agents SDK tool layer.
 * Avoids spinning an LLM; validates the sandbox surface is present and safe.
 */

const ROOT = process.cwd()

describe("Agents SDK tools surface", () => {
  it("ships a real tool executor (not placeholders)", () => {
    const tools = readFileSync(join(ROOT, "server/agents/tools.ts"), "utf8")
    assert.match(tools, /export async function executeTool/)
    assert.match(tools, /case "read"/)
    assert.match(tools, /case "write"/)
    assert.match(tools, /case "edit"/)
    assert.match(tools, /case "bash"/)
    assert.match(tools, /case "glob"/)
    assert.match(tools, /case "grep"/)
    assert.match(tools, /case "web_search"/)
    assert.match(tools, /case "web_fetch"/)
    assert.match(tools, /resolveInRoot/)
    assert.match(tools, /BASH_BLOCKLIST/)
    assert.doesNotMatch(tools, /result placeholder/)
  })

  it("run route executes tools instead of stubbing them", () => {
    const route = readFileSync(join(ROOT, "app/api/agents/run/route.ts"), "utf8")
    assert.match(route, /executeTool/)
    assert.match(route, /createWorkspace/)
    assert.match(route, /tool_result/)
    assert.doesNotMatch(route, /result placeholder/)
  })

  it("registers the enterprise-builder agent", () => {
    const path = join(ROOT, "agents/enterprise-builder.toml")
    assert.equal(existsSync(path), true)
    const raw = readFileSync(path, "utf8")
    assert.match(raw, /id = "enterprise-builder"/)
    assert.match(raw, /write = true/)
    assert.match(raw, /spawn_subagent = true/)
  })

  it("apps page mounts Codex App Builder + Agents SDK tabs", () => {
    const page = readFileSync(join(ROOT, "app/apps/page.tsx"), "utf8")
    assert.match(page, /CodexAgentPanel/)
    assert.match(page, /surface="apps"/)
    assert.match(page, /AgentsList/)
    assert.match(page, /App Builder/)
  })
})
