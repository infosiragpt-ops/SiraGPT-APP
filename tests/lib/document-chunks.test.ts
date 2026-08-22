import { describe, it, expect } from 'vitest'
import {
  CHUNKED_MODE_THRESHOLD_CHARS,
  MAX_CHUNK_SIZE,
  TARGET_CHUNK_SIZE,
  chunkByParagraphs,
  estimateTotalChunks,
  joinDocumentChunks,
  shouldUseChunkedMode,
} from '@/lib/chat/document-chunks'
import {
  ChunkedDocumentController,
  PAGE_CACHE_LIMIT,
} from '@/components/chat/chunked-editor-controller'

/**
 * Contract tests for the large-document "paginated editor" mode.
 * The critical invariant is EXACT reassembly: join(chunks) === original for
 * every input, including pathological ones (giant paragraphs, \r\n, runs of
 * blank lines, empty input). The controller tests pin the memory model:
 * dirty drafts survive navigation and assembleForSave streams pages once.
 */

// Deterministic PRNG so property-style cases are stable across runs.
function makeRng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function randomDocument(rng: () => number): string {
  const paragraphs: string[] = []
  const count = 1 + Math.floor(rng() * 40)
  for (let i = 0; i < count; i += 1) {
    const kind = rng()
    if (kind < 0.15) paragraphs.push('')
    else if (kind < 0.3) paragraphs.push(`Línea corta ${i}`)
    else if (kind < 0.45) paragraphs.push('Párrafo con\nsaltos\ninternos '.repeat(1 + Math.floor(rng() * 30)))
    else if (kind < 0.55) paragraphs.push('X'.repeat(Math.floor(rng() * 200_000)))
    else paragraphs.push('Texto normal '.repeat(1 + Math.floor(rng() * 4000)))
  }
  return paragraphs.join('\n\n')
}

describe('chunkByParagraphs — exactness invariants', () => {
  it('join(chunks) === original for a normal markdown document', () => {
    const doc = '# Título\n\nPrimer párrafo.\n\nSegundo párrafo con **negritas**.\n\n## Sección\n\nCierre.'
    const chunks = chunkByParagraphs(doc)
    expect(joinDocumentChunks(chunks)).toBe(doc)
  })

  it('preserves leading/trailing blank lines and blank-line RUNS verbatim', () => {
    for (const doc of ['\n\ninicio', 'final\n\n', '\n\n\nmedio\n\n\n\nfin', '\n', 'a\n\n\n\nb']) {
      expect(joinDocumentChunks(chunkByParagraphs(doc))).toBe(doc)
    }
  })

  it('round-trips CRLF documents byte-exactly (no silent normalization)', () => {
    const doc = 'uno\r\n\r\ndos\r\n\r\ntres'
    expect(joinDocumentChunks(chunkByParagraphs(doc))).toBe(doc)
  })

  it('empty / null input yields no chunks and join("") stays empty', () => {
    expect(chunkByParagraphs('')).toEqual([])
    expect(joinDocumentChunks([])).toBe('')
    expect(joinDocumentChunks(null as unknown as never[])).toBe('')
  })

  it('property: over 200 randomized docs, reassembly is EXACT and max size holds', () => {
    const rng = makeRng(20260822)
    for (let round = 0; round < 200; round += 1) {
      const doc = randomDocument(rng)
      const chunks = chunkByParagraphs(doc)
      expect(joinDocumentChunks(chunks)).toBe(doc)
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE)
      }
      // Indexes are sequential.
      chunks.forEach((chunk, index) => expect(chunk.index).toBe(index))
    }
  })
})

describe('chunkByParagraphs — sizing rules', () => {
  it('splits at paragraph boundaries respecting the ~64KB target', () => {
    const doc = Array.from({ length: 5000 }, (_, i) => `párrafo ${i} con contenido suficiente`).join('\n\n')
    const chunks = chunkByParagraphs(doc)
    expect(chunks.length).toBeGreaterThan(1)
    // Closed chunks reach the target; none exceed the hard max.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.length).toBeGreaterThanOrEqual(TARGET_CHUNK_SIZE / 2)
    }
    expect(joinDocumentChunks(chunks)).toBe(doc)
  })

  it('subdivides a giant paragraph (>max) by lines then hard slices', () => {
    const doc = `intro\n\n${'Z'.repeat(300_000)}\n\noutro`
    const chunks = chunkByParagraphs(doc)
    expect(joinDocumentChunks(chunks)).toBe(doc)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_SIZE)
    }
    expect(chunks.length).toBeGreaterThan(3)
  })

  it('hard-slices a single line larger than max without dropping characters', () => {
    const doc = 'A'.repeat(200_001)
    const chunks = chunkByParagraphs(doc)
    expect(joinDocumentChunks(chunks)).toBe(doc)
    // All full chunks are exactly max-sized; only the tail may be short.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.content.length).toBe(MAX_CHUNK_SIZE)
    }
  })

  it('accepts custom target/max sizes (mirrors server-side clamped ?size=)', () => {
    const doc = Array.from({ length: 400 }, (_, i) => `bloque ${i}`).join('\n\n')
    const chunks = chunkByParagraphs(doc, 1024, 2048)
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(2048)
    }
    expect(joinDocumentChunks(chunks)).toBe(doc)
  })
})

describe('mode decision helpers', () => {
  it('threshold sits at ~8MB and matches the backend constant', () => {
    expect(CHUNKED_MODE_THRESHOLD_CHARS).toBe(8 * 1024 * 1024)
    expect(shouldUseChunkedMode(8 * 1024 * 1024)).toBe(true)
    expect(shouldUseChunkedMode(8 * 1024 * 1024 - 1)).toBe(false)
    expect(shouldUseChunkedMode(0)).toBe(false)
    expect(shouldUseChunkedMode(Number.NaN)).toBe(false)
  })

  it('estimateTotalChunks gives an upper-bound page count for UI labels', () => {
    expect(estimateTotalChunks(0)).toBe(1)
    expect(estimateTotalChunks(TARGET_CHUNK_SIZE)).toBe(1)
    expect(estimateTotalChunks(TARGET_CHUNK_SIZE + 1)).toBe(2)
    expect(estimateTotalChunks(-5)).toBe(1)
  })
})

describe('ChunkedDocumentController — paged memory model', () => {
  function makeDoc(paragraphCount: number, paragraphSize = 1000): string {
    return Array.from(
      { length: paragraphCount },
      (_, i) => `párrafo ${i} ${'c'.repeat(Math.max(1, paragraphSize - 12))}`,
    ).join('\n\n')
  }

  type FetchLog = { fileId: string; index: number }[]
  function makeClient(doc: string, opts: { pageSize?: number } = {}) {
    const fetchLog: FetchLog = []
    const pages = chunkByParagraphs(doc, opts.pageSize ?? TARGET_CHUNK_SIZE)
    return {
      fetchLog,
      client: {
        getFileMeta: async (fileId: string) => ({
          contentChars: doc.length,
          chunkedMode: shouldUseChunkedMode(doc.length),
          targetChunkSize: TARGET_CHUNK_SIZE,
          estimatedTotalChunks: pages.length,
        }),
        getFileChunk: async (fileId: string, index: number) => {
          fetchLog.push({ fileId, index })
          return {
            index,
            totalChunks: pages.length,
            content: pages[index]?.content ?? '',
            nextIndex: index + 1 < pages.length ? index + 1 : null,
          }
        },
      },
      total: pages.length,
      pages,
    }
  }

  it('loadMeta reports chunked mode without fetching any body page', async () => {
    const { client, fetchLog } = makeClient(makeDoc(20_000))
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await expect(controller.loadMeta()).resolves.toBe(true)
    expect(controller.meta?.chunkedMode).toBe(true)
    expect(fetchLog).toHaveLength(0)
  })

  it('dirty drafts survive page navigation and win over cached pages', async () => {
    const { client } = makeClient(makeDoc(6000), { pageSize: 32 * 1024 })
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await controller.loadMeta()

    const page0 = await controller.getPage(0)
    expect(controller.totalChunks).toBeGreaterThan(2)

    // Navigate away and back through the cache.
    await controller.getPage(1)
    await controller.getPage(2)

    // User edits page 0's draft.
    controller.setPageDraft(0, page0 + '\n\nEDIT DEL USUARIO')

    const reread = await controller.getPage(0)
    expect(reread).toContain('EDIT DEL USUARIO')
    expect(controller.hasDirtyPages).toBe(true)
  })

  it('assembleForSave streams each missing page exactly once (single pass)', async () => {
    const doc = makeDoc(8000)
    const { client, fetchLog } = makeClient(doc, { pageSize: 32 * 1024 })
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await controller.loadMeta()

    // Warm a couple of pages, edit one.
    const first = await controller.getPage(0)
    await controller.getPage(1)
    controller.setPageDraft(1, 'REEMPLAZO COMPLETO DE PÁGINA 1')
    fetchLog.length = 0

    const assembled = await controller.assembleForSave()

    // Draft replaced its page verbatim; everything else intact.
    const expectedPages = [...chunkByParagraphs(doc, 32 * 1024)]
    expectedPages[1] = { index: 1, content: 'REEMPLAZO COMPLETO DE PÁGINA 1' }
    expect(assembled).toBe(expectedPages.map((p) => p.content).join(''))
    expect(first.length).toBeGreaterThan(0)

    // Single streaming pass: every uncached page fetched at most once,
    // already-cached/dirty pages NOT re-fetched.
    const fetchedIndexes = fetchLog.map((entry) => entry.index)
    expect(new Set(fetchedIndexes).size).toBe(fetchedIndexes.length)
    expect(fetchedIndexes).not.toContain(0)
    expect(fetchedIndexes).not.toContain(1)
  })

  it('clean-page LRU stays bounded while dirty pages are always retained', async () => {
    const doc = makeDoc(40_000)
    const { client } = makeClient(doc, { pageSize: 16 * 1024 })
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await controller.loadMeta()

    controller.setPageDraft(3, 'borrador importante')
    for (let i = 0; i < 40; i += 1) {
      await controller.getPage(i)
    }
    // Internal caches exposed for observability.
    const internals = controller as unknown as {
      cleanPages: Map<number, string>
      dirtyPages: Map<number, string>
    }
    expect(internals.cleanPages.size).toBeLessThanOrEqual(PAGE_CACHE_LIMIT)
    expect(internals.dirtyPages.get(3)).toBe('borrador importante')
  })

  it('commitSave promotes drafts to clean state after a successful save', async () => {
    const doc = makeDoc(2000)
    const { client } = makeClient(doc, { pageSize: 32 * 1024 })
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await controller.loadMeta()
    await controller.getPage(0)
    controller.setPageDraft(0, 'guardado')
    expect(controller.hasDirtyPages).toBe(true)
    controller.commitSave()
    expect(controller.hasDirtyPages).toBe(false)
  })

  it('assembleForSave throws before meta/first page when nothing was loaded', async () => {
    const { client } = makeClient(makeDoc(10))
    const controller = new ChunkedDocumentController({ fileId: 'f1', client })
    await expect(controller.assembleForSave()).rejects.toThrow('not-ready')
  })

  it('server/client twins agree: same split output for the same document', async () => {
    // The backend service is plain CJS and importable from vitest via require
    // interop; this pins BOTH sides to byte-identical splits.
    const { createRequire } = await import('node:module')
    const nodeRequire = createRequire(import.meta?.url ?? __filename)
    const path = await import('node:path')
    const serverPath = path.resolve(__dirname, '../../backend/src/services/document-chunks.js')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const serverChunks = nodeRequire(serverPath)

    const rng = makeRng(99)
    for (let round = 0; round < 25; round += 1) {
      const doc = randomDocument(rng)
      const clientSplit = chunkByParagraphs(doc, 8 * 1024, 12 * 1024)
      const serverSplit = serverChunks.chunkByParagraphs(doc, 8 * 1024, 12 * 1024)
      expect(serverSplit).toEqual(clientSplit)
      expect(serverChunks.joinChunks(serverSplit)).toBe(doc)
    }
  })
})
