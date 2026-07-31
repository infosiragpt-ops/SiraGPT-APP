import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { validateActiveSession } from "../lib/auth"
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
    let calls = 0
    const requestedAddresses: string[][] = []
    const requestImpl = async (_url: URL, _init: RequestInit, approvedAddresses: ReadonlyArray<string>) => {
      calls += 1
      requestedAddresses.push([...approvedAddresses])
      return new Response(null, { status: 302, headers: { location: "http://private.test/secret" } })
    }
    await assert.rejects(
      safeFetch("https://public.test/start", {}, {
        resolveHost: async (hostname) => hostname === "public.test" ? ["93.184.216.34"] : ["127.0.0.1"],
        requestImpl,
      }),
      /bloqueado/,
    )
    assert.equal(calls, 1)
    assert.deepEqual(requestedAddresses, [["93.184.216.34"]])
  })

  it("pins the approved public address at the connection boundary", async () => {
    const seen: Array<{ host: string; approved: string[] }> = []
    let resolverCalls = 0
    const requestImpl = async (url: URL, _init: RequestInit, approvedAddresses: ReadonlyArray<string>) => {
      seen.push({ host: url.hostname, approved: [...approvedAddresses] })
      return new Response("ok", { status: 200 })
    }
    const result = await safeFetch("https://public.test/start", {}, {
      resolveHost: async () => {
        resolverCalls += 1
        return resolverCalls === 1 ? ["93.184.216.34"] : ["127.0.0.1"]
      },
      requestImpl,
    })
    assert.equal(result.response.status, 200)
    assert.equal(resolverCalls, 1)
    assert.deepEqual(seen, [{ host: "public.test", approved: ["93.184.216.34"] }])
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
    const ownerNamespace = createHash("sha256")
      .update("siragpt-agent-owner:v1\0")
      .update("user-owner")
      .digest("hex")
      .slice(0, 32)
    const ownerRoot = join(base, ownerNamespace)
    const planted = join(ownerRoot, id)
    const outside = mkdtempSync(join(tmpdir(), "siragpt-agent-root-outside-"))
    mkdirSync(ownerRoot, { recursive: true })
    symlinkSync(outside, planted, "dir")
    const ws = createWorkspace(id, "user-owner")
    assert.notEqual(ws.root, outside)
    assert.notEqual(ws.sessionId, id)
  })

  it("rejects a symlinked owner namespace before creating a workspace", () => {
    const ownerId = `owner-symlink-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const ownerNamespace = createHash("sha256")
      .update("siragpt-agent-owner:v1\0")
      .update(ownerId)
      .digest("hex")
      .slice(0, 32)
    const ownerRoot = join(tmpdir(), "siragpt-agent-sessions", ownerNamespace)
    const outside = mkdtempSync(join(tmpdir(), "siragpt-agent-owner-outside-"))
    mkdirSync(join(tmpdir(), "siragpt-agent-sessions"), { recursive: true })
    symlinkSync(outside, ownerRoot, "dir")
    assert.throws(() => createWorkspace("session", ownerId), /owner root/)
  })

  it("binds a session workspace to the authenticated owner", async () => {
    const userA = createWorkspace("shared-session", "user-a")
    const userB = createWorkspace("shared-session", "user-b")
    assert.notEqual(userA.root, userB.root)
    assert.equal((await executeTool("write", { file_path: "private.txt", content: "A-only" }, userA)).ok, true)
    const crossUserRead = await executeTool("read", { file_path: "private.txt" }, userB)
    assert.equal(crossUserRead.ok, false)
    assert.match(crossUserRead.summary || "", /not found/)
  })

  it("enforces the effective agent-role allow-set at execution time", async () => {
    const ws = workspace()
    const readOnly = getEffectiveToolAllowSet({ read: true, write: false })
    const result = await executeTool("write", { file_path: "blocked.txt", content: "x" }, ws, readOnly)
    assert.equal(result.ok, false)
    assert.match(result.summary || "", /tool denied/)
    assert.equal(existsSync(join(ws.root, "blocked.txt")), false)
  })

  it("default-denies bash and subagent execution without an attested boundary", async () => {
    const ws = workspace()
    const roleTools = getEffectiveToolAllowSet({ bash: true, spawn_subagent: true })
    const bash = await executeTool("bash", { command: "cat /etc/passwd; curl http://127.0.0.1 &" }, ws, roleTools)
    const subagent = await executeTool("spawn_subagent", { prompt: "bypass" }, ws, roleTools)
    assert.equal(bash.ok, false)
    assert.match(bash.summary || "", /tool denied/)
    assert.equal(subagent.ok, false)
    assert.match(subagent.summary || "", /tool denied/)
    const directBash = await executeTool("bash", { command: "cat /etc/passwd" }, ws)
    assert.equal(directBash.ok, false)
    assert.match(directBash.summary || "", /bash denied/)
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
    assert.match(route, /validateActiveSession\(token, request\)/)
    assert.match(route, /status: 401/)
    assert.match(route, /webhook_pending_review/)
    assert.doesNotMatch(route, /accepted:\s*true/)
    assert.doesNotMatch(route, /spawnSubagents/)
    assert.match(route, /createWorkspace\(sessionId, ownerId\)/)
    assert.match(route, /allowedTools\.has\(tc\.function\.name\)/)
    assert.match(route, /executeTool\(tc\.function\.name, tc\.function\.arguments, workspace, allowedTools\)/)
  })
})

describe("active session authority contract", () => {
  it("accepts only a live backend session response", async () => {
    const user = await validateActiveSession("opaque-token", undefined, {
      backendBaseUrl: "http://backend.test:5000/api",
      fetchImpl: async () => new Response(JSON.stringify({ user: { id: "user-1", email: "one@example.test" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    })
    assert.deepEqual(user, { id: "user-1", email: "one@example.test", isAdmin: false })
  })

  it("rejects revoked or inactive sessions as unauthorized", async () => {
    const user = await validateActiveSession("revoked-token", undefined, {
      backendBaseUrl: "http://backend.test:5000/api",
      fetchImpl: async () => new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 401 }),
    })
    assert.equal(user, null)
    const unavailable = await validateActiveSession("inactive-token", undefined, {
      backendBaseUrl: "http://backend.test:5000/api",
      fetchImpl: async () => { throw new Error("authority unavailable") },
    })
    assert.equal(unavailable, null)
  })
})
