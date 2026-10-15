import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/client-logs", () => ({ reportClientLog: vi.fn() }))

import { apiClient as api } from "@/lib/api"
import { authenticatedFetch, clearAuthRefreshBlock, clearAuthenticatedFetchCsrfCache } from "@/lib/authenticated-fetch"
import {
  ChunkedUploadPausedError,
  RESUME_STORAGE_KEY,
  createLocalResumeStore,
  createThroughputMeter,
  describeChunkedUploadProgress,
  fingerprintFile,
  formatEtaEs,
  formatRateEs,
  type ChunkedUploadStats,
} from "@/lib/composer/resumable-upload"

/**
 * uploadFileChunked against an in-memory chunked-upload server: the real
 * ApiClient, the real authenticated transport and the real engine; only
 * `fetch` and `XMLHttpRequest` are fakes. A 2-6 GB lecture must survive a
 * dropped connection without losing (or re-sending) the bytes already on the
 * server, and the server session is deleted only on a real cancel.
 */

type Outcome = { status: number; body?: unknown } | "network" | "hang" | "store-then-network"

type Session = {
  name: string
  size: number
  chunkSize: number
  totalChunks: number
  chunks: Map<number, Blob>
  completed: boolean
}

class FakeServer {
  sessions = new Map<string, Session>()
  log: string[] = []
  deletes: RequestInit[] = []
  putAttempts = new Map<number, number>()
  networkDown = false
  inFlight = 0
  maxInFlight = 0
  dispatchOrder: number[] = []
  nextId = 1
  /** Per-chunk behaviour override; undefined = store and answer 200. */
  chunkOutcome: (index: number, attempt: number) => Outcome | undefined = () => undefined
  /** Called after a chunk is stored. */
  onStored: (index: number) => void = () => {}

  newId(): string {
    const id = String(this.nextId++).padStart(32, "a")
    return id
  }
}

let server: FakeServer

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input)
  const method = String(init.method || "GET").toUpperCase()
  if (server.networkDown) throw new TypeError("Failed to fetch")
  if (/\/files\/upload\/chunked\/init$/.test(url) && method === "POST") {
    const body = JSON.parse(String(init.body)) as { name: string; size: number; chunkSize: number }
    const id = server.newId()
    const chunkSize = body.chunkSize
    const totalChunks = Math.ceil(body.size / chunkSize)
    server.sessions.set(id, { name: body.name, size: body.size, chunkSize, totalChunks, chunks: new Map(), completed: false })
    server.log.push("init")
    return json({ uploadId: id, chunkSize, totalChunks, size: body.size }, 201)
  }
  const complete = /\/files\/upload\/chunked\/([a-z0-9]+)\/complete$/.exec(url)
  if (complete && method === "POST") {
    server.log.push("complete")
    const session = server.sessions.get(complete[1])
    if (!session) return json({ error: "La subida no existe o caducó.", code: "upload_not_found" }, 404)
    if (session.chunks.size !== session.totalChunks) return json({ error: "Faltan trozos", code: "chunks_missing" }, 409)
    session.completed = true
    return json({ files: [{ id: "file-1", name: session.name, success: true }], chunked: true })
  }
  const one = /\/files\/upload\/chunked\/([a-z0-9]+)$/.exec(url)
  if (one && method === "GET") {
    server.log.push("status")
    const session = server.sessions.get(one[1])
    if (!session) return json({ error: "La subida no existe o caducó.", code: "upload_not_found" }, 404)
    return json({
      uploadId: one[1],
      name: session.name,
      size: session.size,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      received: [...session.chunks.keys()].sort((a, b) => a - b),
      completed: session.completed,
    })
  }
  if (one && method === "DELETE") {
    server.log.push("delete")
    server.deletes.push(init)
    server.sessions.delete(one[1])
    return json({ ok: true })
  }
  return json({ error: "unexpected" }, 500)
}

class FakeXhr {
  upload: { onprogress: ((ev: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ""
  withCredentials = false
  timeout = 0
  headers: Record<string, string> = {}
  private url = ""
  private done = false

  open(_method: string, url: string) { this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value }
  getResponseHeader() { return null }

  private finish(fn: (() => void) | null) {
    if (this.done) return
    this.done = true
    server.inFlight -= 1
    fn?.()
  }

  abort() { this.finish(this.onabort) }

  send(body: Blob) {
    const match = /\/files\/upload\/chunked\/([a-z0-9]+)\/(\d+)$/.exec(this.url)
    if (!match) throw new Error(`unexpected PUT ${this.url}`)
    const id = match[1]
    const index = Number(match[2])
    const attempt = (server.putAttempts.get(index) || 0) + 1
    server.putAttempts.set(index, attempt)
    server.log.push(`put ${index}`)
    server.dispatchOrder.push(index)
    server.inFlight += 1
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
    expect(this.headers.authorization).toBe("Bearer upload-token")
    const outcome = server.chunkOutcome(index, attempt)
    if (outcome === "hang") return
    setTimeout(() => {
      if (this.done) return
      const session = server.sessions.get(id)
      if (server.networkDown || outcome === "network") {
        this.finish(this.onerror)
        return
      }
      if (!session) {
        this.status = 404
        this.responseText = JSON.stringify({ error: "La subida no existe o caducó.", code: "upload_not_found" })
        this.finish(this.onload)
        return
      }
      if (outcome && outcome !== "store-then-network") {
        this.status = outcome.status
        this.responseText = JSON.stringify(outcome.body ?? {})
        this.finish(this.onload)
        return
      }
      session.chunks.set(index, body)
      server.onStored(index)
      if (outcome === "store-then-network") {
        // The server kept the chunk but the response never reached the client.
        this.finish(this.onerror)
        return
      }
      this.upload.onprogress?.({ loaded: body.size, total: body.size, lengthComputable: true } as ProgressEvent)
      this.status = 200
      this.responseText = JSON.stringify({ index, received: session.chunks.size })
      this.finish(this.onload)
    }, 0)
  }
}

async function blobText(blob: Blob): Promise<string> {
  if (typeof (blob as Blob & { text?: () => Promise<string> }).text === "function") return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

async function assembled(session: Session): Promise<string> {
  const parts: string[] = []
  for (let i = 0; i < session.totalChunks; i += 1) parts.push(await blobText(session.chunks.get(i) as Blob))
  return parts.join("")
}

const CONTENT = "0123456789abcdefghijABCDEFGHIJklmnopqrstKLMNO" // 45 chars → 5 chunks of 10
function lecture(name = "clase.mp3", lastModified = 1_700_000_000_000): File {
  return new File([CONTENT], name, { type: "audio/mpeg", lastModified })
}

const fastTiming = { retryBaseMs: 5, retryMaxMs: 20 }

describe("uploadFileChunked · resumable, parallel, honest", () => {
  beforeEach(() => {
    server = new FakeServer()
    vi.stubGlobal("fetch", vi.fn(fakeFetch))
    vi.stubGlobal("XMLHttpRequest", FakeXhr)
    clearAuthenticatedFetchCsrfCache()
    clearAuthRefreshBlock()
    vi.spyOn(authenticatedFetch.csrfManager, "getToken").mockResolvedValue(null)
    api.setToken("upload-token")
    try { window.localStorage.removeItem(RESUME_STORAGE_KEY) } catch { /* storage blocked */ }
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    api.setToken(null)
  })

  it("sends chunks in parallel (≤ 3 in flight), dispatched in index order, and reassembles the exact bytes", async () => {
    const progress: Array<[number, ChunkedUploadStats]> = []
    const result = await api.uploadFileChunked(lecture(), {
      chunkBytes: 10,
      parallel: 3,
      onProgress: (percent, _loaded, _total, stats) => progress.push([percent, stats]),
    })
    expect(result.files?.[0]).toMatchObject({ id: "file-1", success: true })
    expect(server.dispatchOrder).toEqual([0, 1, 2, 3, 4])
    expect(server.maxInFlight).toBe(3)
    expect(server.log.filter((l) => l === "init")).toHaveLength(1)
    expect(server.log.filter((l) => l === "complete")).toHaveLength(1)
    expect(server.deletes).toHaveLength(0)
    const session = [...server.sessions.values()][0]
    expect(await assembled(session)).toBe(CONTENT)
    const last = progress[progress.length - 1]
    expect(last[0]).toBe(100)
    expect(last[1]).toMatchObject({ phase: "completing", loaded: 45, total: 45 })
    expect(progress.some(([, stats]) => stats.phase === "uploading" && /^Subiendo \d+ B de 45 B/.test(stats.label))).toBe(true)
    // A finished upload leaves no resume record behind.
    expect(window.localStorage.getItem(RESUME_STORAGE_KEY)).toBeNull()
  })

  it("resumes after a network failure without re-sending the chunks the server already has, and never DELETEs", async () => {
    server.chunkOutcome = (index, attempt) => {
      if (index === 1 && attempt === 1) return "store-then-network" // landed, response lost
      if (index === 2 && attempt === 1) return "network" // never landed
      return undefined
    }
    const phases: string[] = []
    const result = await api.uploadFileChunked(lecture(), {
      chunkBytes: 10,
      parallel: 3,
      timing: fastTiming,
      onProgress: (_p, _l, _t, stats) => phases.push(stats.phase),
    })
    expect(result.files?.[0]).toMatchObject({ id: "file-1" })
    expect(server.putAttempts.get(0)).toBe(1)
    expect(server.putAttempts.get(1)).toBe(1) // the status said it was there
    expect(server.putAttempts.get(2)).toBe(2)
    expect(server.putAttempts.get(3)).toBe(1)
    expect(server.putAttempts.get(4)).toBe(1)
    expect(server.log).toContain("status")
    expect(server.deletes).toHaveLength(0)
    expect(phases).toContain("reconnecting")
    expect(await assembled([...server.sessions.values()][0])).toBe(CONTENT)
  })

  it("rides out a 60 s outage mid-upload (fake clock): pauses, resumes, no DELETE, received chunks kept", async () => {
    vi.useFakeTimers()
    let outageUntil = 0
    server.onStored = (index) => {
      if (index === 1) {
        server.networkDown = true
        outageUntil = Date.now() + 60_000
      }
    }
    const labels: string[] = []
    let settled = false
    const upload = api.uploadFileChunked(lecture(), {
      chunkBytes: 10,
      parallel: 1,
      onProgress: (_p, _l, _t, stats) => labels.push(stats.label),
    })
    upload.then(() => { settled = true }, () => { settled = true })
    for (let i = 0; i < 600 && !settled; i += 1) {
      await vi.advanceTimersByTimeAsync(500)
      if (server.networkDown && outageUntil && Date.now() >= outageUntil) server.networkDown = false
    }
    const result = await upload
    expect(result.files?.[0]).toMatchObject({ id: "file-1" })
    expect(server.deletes).toHaveLength(0)
    expect(server.log.filter((l) => l === "init")).toHaveLength(1)
    expect(server.putAttempts.get(0)).toBe(1)
    expect(server.putAttempts.get(1)).toBe(1)
    expect(labels).toContain("Conexión perdida — reanudando")
    vi.useRealTimers()
    expect(await assembled([...server.sessions.values()][0])).toBe(CONTENT)
  })

  it("an `online` event wakes a paused upload before its backoff expires", async () => {
    let first = true
    server.chunkOutcome = (index) => {
      if (index === 2 && first) {
        first = false
        return "network"
      }
      return undefined
    }
    const startedAt = Date.now()
    const upload = api.uploadFileChunked(lecture(), {
      chunkBytes: 10,
      parallel: 1,
      // A 10-minute backoff: only the `online` wake-up can finish this test in time.
      timing: { retryBaseMs: 600_000, retryMaxMs: 600_000 },
      onProgress: (_p, _l, _t, stats) => {
        if (stats.phase === "reconnecting") setTimeout(() => window.dispatchEvent(new Event("online")), 5)
      },
    })
    await expect(upload).resolves.toMatchObject({ chunked: true })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(server.deletes).toHaveLength(0)
  })

  it("a user cancel aborts the in-flight chunk, DELETEs the session (keepalive) and forgets the resume record", async () => {
    server.chunkOutcome = (index) => (index === 2 ? "hang" : undefined)
    const controller = new AbortController()
    server.onStored = (index) => {
      if (index === 1) setTimeout(() => controller.abort(), 5)
    }
    const upload = api.uploadFileChunked(lecture(), { chunkBytes: 10, parallel: 1, signal: controller.signal })
    await expect(upload).rejects.toMatchObject({ name: "AbortError" })
    expect(server.deletes).toHaveLength(1)
    expect(server.deletes[0].keepalive).toBe(true)
    expect(server.deletes[0].signal?.aborted ?? false).toBe(false)
    expect(server.log).not.toContain("complete")
    expect(window.localStorage.getItem(RESUME_STORAGE_KEY)).toBeNull()
  })

  it("a non-retriable 4xx deletes the session and surfaces the server's Spanish message", async () => {
    server.chunkOutcome = (index) => (index === 1 ? { status: 400, body: { error: "El trozo 1 debía medir 10 bytes y mide 9.", code: "bad_chunk_size" } } : undefined)
    await expect(api.uploadFileChunked(lecture(), { chunkBytes: 10, parallel: 1, timing: fastTiming }))
      .rejects.toThrow(/El trozo 1 debía medir/)
    expect(server.deletes).toHaveLength(1)
    expect(window.localStorage.getItem(RESUME_STORAGE_KEY)).toBeNull()
  })

  it("a long outage stops WITHOUT deleting; re-attaching the same file after a reload resumes from the server", async () => {
    server.onStored = (index) => {
      if (index === 2) server.networkDown = true
    }
    const file = lecture()
    const first = api.uploadFileChunked(file, { chunkBytes: 10, parallel: 1, timing: { ...fastTiming, maxPauseMs: 60 } })
    await expect(first).rejects.toBeInstanceOf(ChunkedUploadPausedError)
    await expect(first).rejects.toThrow(/vuelve a adjuntar el mismo archivo para continuar/)
    expect(server.deletes).toHaveLength(0)
    const record = JSON.parse(String(window.localStorage.getItem(RESUME_STORAGE_KEY)))
    expect(Object.keys(record)).toEqual([fingerprintFile(file)])

    // "Reload": the network is back and the user drops the same file again.
    server.networkDown = false
    const before = new Map(server.putAttempts)
    const again = new File([CONTENT], "clase.mp3", { type: "audio/mpeg", lastModified: file.lastModified })
    const resumed: ChunkedUploadStats[] = []
    const result = await api.uploadFileChunked(again, {
      chunkBytes: 10,
      parallel: 2,
      timing: fastTiming,
      onProgress: (_p, _l, _t, stats) => resumed.push(stats),
    })
    expect(result.files?.[0]).toMatchObject({ id: "file-1" })
    expect(server.log.filter((l) => l === "init")).toHaveLength(1) // no second session
    // Chunks 0-2 landed before the outage: never sent again. Chunk 3 failed
    // during the outage and 4 was never tried: each goes exactly once more.
    for (const index of [0, 1, 2]) expect(server.putAttempts.get(index)).toBe(before.get(index))
    expect(server.putAttempts.get(3)).toBe((before.get(3) || 0) + 1)
    expect(server.putAttempts.get(4)).toBe((before.get(4) || 0) + 1)
    expect(resumed.some((s) => s.resumed && s.loaded >= 30)).toBe(true)
    expect(window.localStorage.getItem(RESUME_STORAGE_KEY)).toBeNull()
  })

  it("a resume record whose session expired on the server starts a fresh upload", async () => {
    const file = lecture()
    const store = createLocalResumeStore()
    store.set(fingerprintFile(file) as string, { uploadId: "f".repeat(32), size: 45, chunkSize: 10, totalChunks: 5, savedAt: Date.now() })
    const result = await api.uploadFileChunked(file, { chunkBytes: 10, parallel: 3, timing: fastTiming })
    expect(result.files?.[0]).toMatchObject({ id: "file-1" })
    expect(server.log.slice(0, 2)).toEqual(["status", "init"])
    expect(server.deletes).toHaveLength(0)
  })

  it("auth loss and a full server disk stop the upload without deleting it (resumable later)", async () => {
    server.chunkOutcome = (index) => (index === 1 ? { status: 507, body: { error: "No hay espacio suficiente en el servidor para guardar este archivo.", code: "insufficient_storage" } } : undefined)
    await expect(api.uploadFileChunked(lecture(), { chunkBytes: 10, parallel: 1, timing: fastTiming }))
      .rejects.toThrow(/No hay espacio suficiente/)
    expect(server.deletes).toHaveLength(0)
    expect(window.localStorage.getItem(RESUME_STORAGE_KEY)).not.toBeNull()
  })
})

describe("resumable upload helpers", () => {
  it("formats the chip line in Spanish", () => {
    const MB = 1024 * 1024
    const GB = 1024 * MB
    expect(describeChunkedUploadProgress({
      percent: 30, loaded: 1.2 * GB, total: 4 * GB, bytesPerSec: 9 * MB, etaSeconds: 6 * 60, phase: "uploading", resumed: false,
    })).toBe("Subiendo 1,2 GB de 4,0 GB · 9 MB/s · quedan 6 min")
    expect(describeChunkedUploadProgress({
      percent: 30, loaded: 1, total: 2, bytesPerSec: null, etaSeconds: null, phase: "reconnecting", resumed: false,
    })).toBe("Conexión perdida — reanudando")
    expect(formatRateEs(12.4 * MB)).toBe("12 MB/s")
    expect(formatRateEs(1.5 * MB)).toBe("1,5 MB/s")
    expect(formatRateEs(300 * 1024)).toBe("300 KB/s")
    expect(formatRateEs(null)).toBeNull()
    expect(formatEtaEs(42)).toBe("quedan 42 s")
    expect(formatEtaEs(80 * 60)).toBe("quedan 1 h 20 min")
    expect(formatEtaEs(null)).toBeNull()
  })

  it("computes an EMA of bytes/s that ignores pauses and failed partial chunks", () => {
    const meter = createThroughputMeter({ alpha: 0.5, minSampleMs: 500 })
    expect(meter.sample(0, 0)).toBeNull()
    expect(meter.sample(1_000, 1_000_000)).toBe(1_000_000)
    expect(meter.sample(2_000, 3_000_000)).toBe(1_500_000)
    expect(meter.sample(2_100, 9_000_000)).toBe(1_500_000) // too soon to sample
    meter.resetBaseline() // a 60 s pause
    expect(meter.sample(62_000, 9_000_000)).toBe(1_500_000)
    expect(meter.sample(63_000, 10_000_000)).toBe(1_250_000)
    expect(meter.sample(64_000, 9_500_000)).toBe(1_250_000) // a failed chunk left the total
  })

  it("the resume store survives blocked storage and drops stale records", () => {
    const blocked = createLocalResumeStore({ storage: () => { throw new DOMException("blocked", "SecurityError") } })
    expect(() => blocked.set("a|1|1", { uploadId: "x", size: 1, chunkSize: 1, totalChunks: 1, savedAt: 1 })).not.toThrow()
    expect(blocked.get("a|1|1")).toBeNull()
    expect(() => blocked.remove("a|1|1")).not.toThrow()

    let now = 1_000
    const memory = new Map<string, string>()
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => { memory.set(k, v) },
      removeItem: (k: string) => { memory.delete(k) },
    } as unknown as Storage
    const store = createLocalResumeStore({ storage: () => storage, now: () => now, maxAgeMs: 10_000 })
    store.set("clase.mp4|9|7", { uploadId: "u1", size: 9, chunkSize: 1, totalChunks: 9, savedAt: now })
    expect(store.get("clase.mp4|9|7")?.uploadId).toBe("u1")
    now += 20_000
    expect(store.get("clase.mp4|9|7")).toBeNull()
    memory.set(RESUME_STORAGE_KEY, "{not json")
    expect(store.get("anything")).toBeNull()
    expect(fingerprintFile({ name: "x.mp3", size: 0, lastModified: 1 })).toBeNull()
    expect(fingerprintFile({ name: "x.mp3", size: 5, lastModified: 9 })).toBe("x.mp3|5|9")
  })
})
