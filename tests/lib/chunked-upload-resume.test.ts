import { File as NodeFile } from "node:buffer"
import { webcrypto } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiClient as api } from "@/lib/api"
import { identifyChunkedFile, readChunkedUploadPointer } from "@/lib/composer/chunked-upload"
vi.mock("@/lib/client-logs", () => ({ reportClientLog: vi.fn() }))
const MB = 1024 * 1024
const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
const file = (fill = 1) => new NodeFile([new Uint8Array(2 * MB + 11).fill(fill)], "lesson.mp4", { type: "video/mp4" }) as unknown as File

describe("resumable chunk transport", () => {
  beforeEach(() => { localStorage.clear(); api.setToken("fixture-session"); vi.stubGlobal("crypto", webcrypto) })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); api.setToken(null); localStorage.clear() })

  it("retains acknowledged chunks after a network failure and reselecting resumes only the missing bytes", async () => {
    const selected = file()
    let session: any, offline = true
    const calls: string[] = []
    const received: number[] = []
    vi.spyOn(api as any, "authenticatedFetch").mockImplementation(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname; calls.push(`${init.method} ${path}`)
      if (path.endsWith("/auth/me")) return json({ user: { id: "owner1" } })
      if (path.endsWith("/init")) { session = { ...JSON.parse(String(init.body)), uploadId: "a".repeat(32), totalChunks: 3, received, status: "uploading" }; return json(session, 201) }
      if (path.endsWith("/status")) return json(session)
      if (path.endsWith("/complete")) return json({ files: [{ id: "file1" }], chunked: true })
      const index = Number(path.split("/").pop())
      if (index === 1 && offline) return json({ error: "offline" }, 503)
      received.push(index); return json({ received: received.length })
    })
    await expect(api.uploadFileChunked(selected, { chunkBytes: MB, maxRetries: 0 })).rejects.toThrow("offline")
    expect(received).toEqual([0])
    expect(calls.some(call => call.startsWith("DELETE"))).toBe(false)
    offline = false
    await expect(api.uploadFileChunked(selected, { chunkBytes: MB, maxRetries: 0 })).resolves.toMatchObject({ files: [{ id: "file1" }] })
    expect(calls.filter(call => call.endsWith("/0"))).toHaveLength(1)
    expect(calls.filter(call => call.endsWith("/init"))).toHaveLength(1)
    expect(received).toEqual([0, 1, 2])
  })

  it("file bytes define identity, and resume pointers cannot cross owners", async () => {
    const a = await identifyChunkedFile(file(1), MB)
    const b = await identifyChunkedFile(file(2), MB)
    expect(a.fingerprint).not.toBe(b.fingerprint)
    localStorage.setItem(`siragpt:chunked-upload:v1:owner1:${a.fingerprint}`, "a".repeat(32))
    expect(readChunkedUploadPointer("owner2", a.fingerprint)).toBeNull()
    expect(readChunkedUploadPointer("owner1", b.fingerprint)).toBeNull()
  })

  it("explicit chip cancellation deletes unfinished chunks, while changing sessions never does", async () => {
    const selected = file()
    const controller = new AbortController()
    const calls: string[] = []
    vi.spyOn(api as any, "authenticatedFetch").mockImplementation(async (url: string, init: RequestInit) => {
      calls.push(String(init.method))
      if (url.endsWith("/auth/me")) return json({ user: { id: "owner1" } })
      if (url.endsWith("/init")) { const identity = JSON.parse(String(init.body)); controller.abort(); return json({ ...identity, uploadId: "b".repeat(32), totalChunks: 3, received: [] }) }
      return json({ ok: true })
    })
    await expect(api.uploadFileChunked(selected, { chunkBytes: MB, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toEqual(["GET", "POST", "DELETE"])
    vi.restoreAllMocks(); calls.length = 0
    vi.spyOn(api as any, "authenticatedFetch").mockImplementation(async (url: string, init: RequestInit) => {
      calls.push(String(init.method))
      if (url.endsWith("/auth/me")) return json({ user: { id: "owner1" } })
      const identity = JSON.parse(String(init.body)); api.setToken("different-owner-session")
      return json({ ...identity, uploadId: "c".repeat(32), totalChunks: 3, received: [] })
    })
    await expect(api.uploadFileChunked(selected, { chunkBytes: MB })).rejects.toMatchObject({ status: 401 })
    expect(calls).toEqual(["GET", "POST"])
  })

  it("keeps the resume pointer when explicit cancellation is not acknowledged", async () => {
    const selected = file()
    const { fingerprint } = await identifyChunkedFile(selected, MB)
    const controller = new AbortController()
    const uploadId = "d".repeat(32)
    vi.spyOn(api as any, "authenticatedFetch").mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/auth/me")) return json({ user: { id: "owner1" } })
      if (init.method === "DELETE") return json({ error: "temporarily unavailable" }, 503)
      controller.abort()
      return json({ ...JSON.parse(String(init.body)), uploadId, totalChunks: 3, received: [] })
    })
    await expect(api.uploadFileChunked(selected, { chunkBytes: MB, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(readChunkedUploadPointer("owner1", fingerprint)).toBe(uploadId)
  })
})
