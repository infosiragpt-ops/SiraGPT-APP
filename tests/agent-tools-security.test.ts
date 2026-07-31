import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import {
  createWorkspace,
  executeTool,
  getEffectiveToolAllowSet,
  listWorkspaceFiles,
  type AgentWorkspace,
} from "../server/agents/tools"
import { isBlockedAddress, readResponseCapped, safeFetch } from "../server/agents/safe-network"

function workspace(): AgentWorkspace {
  const root = mkdtempSync(join(tmpdir(), "siragpt-agent-security-"))
  return { root, sessionId: "security-test" }
}

describe("agent tools security boundaries", () => {
  it("blocks private and special-use IP literals", () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "192.168.1.5", "::1", "fc00::1", "fe80::1"]) {
      assert.equal(isBlockedAddress(address), true, address)
    }
    assert.equal(isBlockedAddress("93.184.216.34"), false)
  })

  it("validates every redirect before issuing the next request", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: "http://private.test/secret" } })
    }) as typeof fetch
    try {
      await assert.rejects(
        safeFetch("https://public.test/start", {}, {
          resolveHost: async (hostname) => hostname === "public.test" ? ["93.184.216.34"] : ["127.0.0.1"],
        }),
        /bloqueado/,
      )
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("caps streamed response bodies and cancels after the cap", async () => {
    const body = await readResponseCapped(new Response("0123456789"), 4)
    assert.equal(body.text, "0123")
    assert.equal(body.truncated, true)
  })

  it("rejects symlink traversal and omits symlinked files from discovery", async () => {
    const ws = workspace()
    const outside = mkdtempSync(join(tmpdir(), "siragpt-agent-outside-"))
    writeFileSync(join(outside, "secret.txt"), "not sandboxed")
    symlinkSync(outside, join(ws.root, "escape"), "dir")

    const result = await executeTool("read", { file_path: "escape/secret.txt" }, ws)
    assert.equal(result.ok, false)
    assert.match(result.summary || "", /path denied/)
    assert.deepEqual(listWorkspaceFiles(ws), [])
  })

  it("does not reuse a symlink planted at a user-controlled workspace id", () => {
    const id = `symlink-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const base = join(tmpdir(), "siragpt-agent-sessions")
    const planted = join(base, id)
    const outside = mkdtempSync(join(tmpdir(), "siragpt-agent-root-outside-"))
    mkdirSync(base, { recursive: true })
    symlinkSync(outside, planted, "dir")
    const ws = createWorkspace(id)
    assert.notEqual(ws.root, outside)
    assert.notEqual(ws.sessionId, id)
  })

  it("enforces the effective agent-role allow-set at execution time", async () => {
    const ws = workspace()
    const readOnly = getEffectiveToolAllowSet({ read: true, write: false })
    const result = await executeTool("write", { file_path: "blocked.txt", content: "x" }, ws, readOnly)
    assert.equal(result.ok, false)
    assert.match(result.summary || "", /tool denied/)
    assert.equal(existsSync(join(ws.root, "blocked.txt")), false)
  })

  it("uses a read/hash precondition for compatible writes and edits", async () => {
    const ws = workspace()
    mkdirSync(ws.root, { recursive: true })
    const initial = "before"
    const initialHash = createHash("sha256").update(initial).digest("hex")
    assert.equal((await executeTool("write", { file_path: "note.txt", content: initial }, ws)).ok, true)

    const stale = await executeTool("write", { file_path: "note.txt", content: "stale", expected_sha256: "0".repeat(64) }, ws)
    assert.equal(stale.ok, false)
    assert.match(stale.summary || "", /precondition failed/)

    const updated = await executeTool("write", { file_path: "note.txt", content: "after", expected_sha256: initialHash }, ws)
    assert.equal(updated.ok, true)
    const afterHash = createHash("sha256").update("after").digest("hex")
    const edited = await executeTool("edit", { file_path: "note.txt", old_string: "after", new_string: "final", expected_sha256: afterHash }, ws)
    assert.equal(edited.ok, true)
  })
})

describe("agents run route security contract", () => {
  it("keeps auth, webhook validation, and tool policy server-side", async () => {
    const route = readFileSync(join(process.cwd(), "app/api/agents/run/route.ts"), "utf8")
    assert.match(route, /validateSession\(/)
    assert.match(route, /status: 401/)
    assert.match(route, /validateSafeUrl\(webhook_url\)/)
    assert.match(route, /allowedTools\.has\(tc\.function\.name\)/)
    assert.match(route, /executeTool\(tc\.function\.name, tc\.function\.arguments, workspace, allowedTools\)/)
  })
})
