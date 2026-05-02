import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createRequire } from "node:module"

const cjsRequire = createRequire(__filename)

type Rag = {
  chunk: (text: string, opts?: { size?: number; overlap?: number }) => string[]
  cosine: (a: Float32Array | number[], b: Float32Array | number[]) => number
  formatRetrievalHit: (hit: Record<string, unknown>, opts?: { includeDiagnostics?: boolean }) => Record<string, any>
  stats: (userId: string, collection: string) => Promise<{ chunks: number; dim: number }>
  EMBED_DIM: number
}

type StreamCache = {
  start: (
    userId: string,
    chatId: string,
    opts?: { ttlMs?: number; title?: string }
  ) => Promise<{ append: (c: string) => void; complete: () => void; fail: (m: string) => void; forget: () => void }>
  resume: (userId: string, chatId: string) => Promise<null | {
    status: "streaming" | "done" | "error"
    content: string
    title: string
    error: string | null
    startedAt: number
    updatedAt: number
  }>
  _reset: () => Promise<void>
  _size: () => Promise<number>
}

const rag = cjsRequire("../../backend/src/services/rag-service") as Rag
const streamCache = cjsRequire("../../backend/src/services/stream-cache") as StreamCache

describe("rag-service · chunk", () => {
  it("returns an empty array for empty / non-string input", () => {
    assert.deepEqual(rag.chunk(""), [])
    assert.deepEqual(rag.chunk(null as unknown as string), [])
  })

  it("returns a single piece when the text fits inside the size", () => {
    const short = "This is a short paragraph about nothing in particular."
    assert.deepEqual(rag.chunk(short, { size: 4000, overlap: 200 }), [short])
  })

  it("splits long text into multiple pieces", () => {
    const para = "Sentence one. Sentence two! Sentence three? ".repeat(40)
    const pieces = rag.chunk(para, { size: 300, overlap: 50 })
    assert.ok(pieces.length >= 2, `expected at least 2 chunks, got ${pieces.length}`)
  })

  it("keeps each chunk close to the requested size (within a reasonable margin)", () => {
    const para = "Sentence alpha. Sentence beta! Sentence gamma? ".repeat(80)
    const SIZE = 400
    const pieces = rag.chunk(para, { size: SIZE, overlap: 50 })
    for (const p of pieces) assert.ok(p.length <= SIZE * 1.4, `chunk exceeded 1.4× size: ${p.length}`)
  })
})

describe("rag-service · cosine", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = Float32Array.from([1, 2, 3, 4])
    assert.ok(Math.abs(rag.cosine(v, v) - 1) < 1e-6)
  })

  it("returns 0 for orthogonal vectors", () => {
    const a = Float32Array.from([1, 0, 0, 0])
    const b = Float32Array.from([0, 1, 0, 0])
    assert.ok(Math.abs(rag.cosine(a, b)) < 1e-6)
  })

  it("returns -1 for opposite vectors", () => {
    const a = Float32Array.from([1, 2, 3])
    const b = Float32Array.from([-1, -2, -3])
    assert.ok(Math.abs(rag.cosine(a, b) + 1) < 1e-6)
  })

  it("is commutative (a·b === b·a)", () => {
    const a = Float32Array.from([0.1, 0.2, 0.3, 0.4])
    const b = Float32Array.from([0.5, -0.1, 0.2, 0.8])
    assert.ok(Math.abs(rag.cosine(a, b) - rag.cosine(b, a)) < 1e-9)
  })
})

describe("rag-service · stats", () => {
  it("reports zero chunks for an empty collection", async () => {
    const s = await rag.stats("user-unknown", "empty-collection")
    assert.equal(s.chunks, 0)
    assert.equal(s.dim, rag.EMBED_DIM)
  })
})

describe("rag-service · retrieval hit diagnostics", () => {
  it("strips internal ranking fields unless diagnostics are requested", () => {
    const clean = rag.formatRetrievalHit({
      text: "alpha",
      source: "doc",
      score: 0.123456789,
      _idx: 7,
      semanticRank: 1,
      textRank: 2,
      fusedScore: 0.02,
      vectorScore: 0.91,
      textScore: 3.2,
    })

    assert.equal(clean.text, "alpha")
    assert.equal(clean.score, 0.123457)
    assert.equal("_idx" in clean, false)
    assert.equal("semanticRank" in clean, false)
    assert.equal("diagnostics" in clean, false)
  })

  it("returns OpenClaw-style vector/text/fusion diagnostics when requested", () => {
    const explained = rag.formatRetrievalHit({
      text: "beta",
      score: 0.02,
      semanticRank: 4,
      textRank: 1,
      vectorScore: 0.74,
      textScore: 2.5,
      fusionScore: 0.02,
      retrievalMode: "hybrid_rrf",
    }, { includeDiagnostics: true })

    assert.equal(explained.diagnostics.schema_version, "sira.rag_hit_diagnostics.v1")
    assert.equal(explained.diagnostics.mode, "hybrid_rrf")
    assert.equal(explained.diagnostics.vectorScore, 0.74)
    assert.equal(explained.diagnostics.textScore, 2.5)
    assert.equal(explained.diagnostics.fusionScore, 0.02)
    assert.equal(explained.diagnostics.semanticRank, 4)
    assert.equal(explained.diagnostics.textRank, 1)
  })
})

describe("stream-cache · lifecycle", () => {
  it("creates an entry that resume() can read", async () => {
    await streamCache._reset()
    const h = await streamCache.start("u1", "c1", { title: "hello" })
    h.append("first ")
    h.append("second")
    const snap = await streamCache.resume("u1", "c1")
    assert.ok(snap, "resume should return a snapshot")
    assert.equal(snap!.status, "streaming")
    assert.equal(snap!.content, "first second")
    assert.equal(snap!.title, "hello")
  })

  it("marks complete → status 'done'", async () => {
    await streamCache._reset()
    ;(await streamCache.start("u2", "c2")).complete()
    assert.equal((await streamCache.resume("u2", "c2"))!.status, "done")
  })

  it("marks fail → status 'error' with message", async () => {
    await streamCache._reset()
    ;(await streamCache.start("u3", "c3")).fail("kaboom")
    const snap = (await streamCache.resume("u3", "c3"))!
    assert.equal(snap.status, "error")
    assert.equal(snap.error, "kaboom")
  })

  it("returns null for an unknown chat", async () => {
    await streamCache._reset()
    assert.equal(await streamCache.resume("ghost", "nope"), null)
  })

  it("isolates entries across users", async () => {
    await streamCache._reset()
    ;(await streamCache.start("userA", "sharedChat")).append("A only")
    ;(await streamCache.start("userB", "sharedChat")).append("B only")
    assert.equal((await streamCache.resume("userA", "sharedChat"))!.content, "A only")
    assert.equal((await streamCache.resume("userB", "sharedChat"))!.content, "B only")
  })

  it("forget() removes the entry", async () => {
    await streamCache._reset()
    const h = await streamCache.start("u4", "c4")
    h.append("temp")
    assert.equal(await streamCache._size(), 1)
    h.forget()
    assert.equal(await streamCache._size(), 0)
  })

  it("append on a complete()'d stream still extends content", async () => {
    await streamCache._reset()
    const h = await streamCache.start("u5", "c5")
    h.append("before")
    h.complete()
    h.append(" after")
    assert.equal((await streamCache.resume("u5", "c5"))!.content, "before after")
  })

  it("append ignores empty / falsy chunks", async () => {
    await streamCache._reset()
    const h = await streamCache.start("u6", "c6")
    h.append("")
    h.append(null as unknown as string)
    h.append("real")
    assert.equal((await streamCache.resume("u6", "c6"))!.content, "real")
  })
})

describe("route modules load clean", () => {
  it("rag route module loads without error", () => {
    const mod = cjsRequire("../../backend/src/routes/rag")
    assert.ok(mod, "rag route should export an Express router")
  })

  it("chats route module still loads after adding pending-stream endpoint", () => {
    const mod = cjsRequire("../../backend/src/routes/chats")
    assert.ok(mod)
  })

  it("research route module still loads after adding the critic pass", () => {
    const mod = cjsRequire("../../backend/src/routes/research")
    assert.ok(mod)
  })
})
