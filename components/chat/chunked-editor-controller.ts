/**
 * chunked-editor-controller — the stateless memory discipline for the
 * "Documento grande — modo paginado" mode of DocumentEditorPanel.
 *
 * Why a plain controller (no React): the tricky part of the large-document
 * editor is NOT markup, it is the data path:
 *
 *   - The full document never lives in editor state.
 *   - Pages arrive from GET /api/files/:id/chunks one at a time; only the
 *     current page is mounted in an editor instance by the panel.
 *   - Unsaved edits live per page in `dirtyPages`.
 *   - A small LRU of CLEAN pages keeps prev/next instant without pinning
 *     the whole document (dirty pages are always retained).
 *   - `assembleForSave` rebuilds the complete markdown ONCE, streaming
 *     page-by-page into a single accumulator and fetching from the network
 *     only what is neither dirty nor cached — there are never two full
 *     copies alive at once. The result feeds the existing
 *     POST /files/:id/edit contract unchanged.
 *
 * Pure TypeScript: no DOM, no React, no fs — runs in vitest/jsdom and under
 * node --test via the compiled tests bundle.
 */

import type { DocumentChunk } from "@/lib/chat/document-chunks"

export type ChunkFileMeta = {
  contentChars: number
  chunkedMode: boolean
  targetChunkSize: number
  estimatedTotalChunks: number
}

export type ChunkFetchResponse = {
  index: number
  totalChunks: number
  content: string
  nextIndex: number | null
}

/** Minimal apiClient surface this controller needs (real ApiClient implements both). */
export type ChunkedEditorClient = {
  getFileMeta?: (fileId: string) => Promise<ChunkFileMeta>
  getFileChunk?: (fileId: string, index: number, size?: number) => Promise<ChunkFetchResponse>
}

export type ChunkedEditorOptions = {
  fileId: string
  /** Injectable fetcher — defaults to the injected client's methods. */
  client?: ChunkedEditorClient
}

/** Clean pages retained for instant back/forward navigation. */
export const PAGE_CACHE_LIMIT = 6

export class ChunkedDocumentController {
  private readonly fileId: string
  private readonly client: ChunkedEditorClient

  /** Unsaved user edits, keyed by page index. Always retained. */
  private readonly dirtyPages = new Map<number, string>()
  /** Bounded cache of verbatim server pages. */
  private readonly cleanPages = new Map<number, string>()

  meta: ChunkFileMeta | null = null
  totalChunks = 0
  pageIndex = 0

  constructor(options: ChunkedEditorOptions) {
    this.fileId = options.fileId
    this.client = options.client || {}
  }

  // ---- Loading -------------------------------------------------------------

  /**
   * Early mode decision WITHOUT transferring the body. Returns true when the
   * server says the document must open paginated.
   */
  async loadMeta(): Promise<boolean> {
    if (typeof this.client.getFileMeta !== "function") {
      throw new Error("meta-unavailable")
    }
    const meta = await this.client.getFileMeta(this.fileId)
    this.meta = meta ?? null
    return Boolean(meta?.chunkedMode)
  }

  /**
   * Resolve the content of a page: dirty draft first, then bounded clean
   * cache, then the network. Marks the page current on success.
   */
  async getPage(index: number): Promise<string> {
    const dirty = this.dirtyPages.get(index)
    if (typeof dirty === "string") {
      this.pageIndex = index
      return dirty
    }
    const cached = this.cleanPages.get(index)
    if (typeof cached === "string") {
      this.pageIndex = index
      return cached
    }
    if (typeof this.client.getFileChunk !== "function") {
      throw new Error("chunk-fetcher-unavailable")
    }
    const response = await this.client.getFileChunk(this.fileId, index)
    if (!response || typeof response.content !== "string") {
      throw new Error(`chunk-${index}-unavailable`)
    }
    if (Number.isFinite(response.totalChunks) && response.totalChunks > 0) {
      this.totalChunks = response.totalChunks
    }
    this.cleanPages.set(index, response.content)
    this.trimCleanCache()
    this.pageIndex = index
    return response.content
  }

  private trimCleanCache(): void {
    while (this.cleanPages.size > PAGE_CACHE_LIMIT) {
      const oldest = this.cleanPages.keys().next().value
      if (oldest === undefined) break
      this.cleanPages.delete(oldest)
    }
  }

  /** First-load convenience used by tests and the panel bootstrap. */
  static fromFirstChunk(response: ChunkFetchResponse): {
    chunks: DocumentChunk[]
    totalChunks: number
  } {
    const totalChunks = response?.totalChunks ?? 1
    const first: DocumentChunk = { index: response?.index ?? 0, content: response?.content ?? "" }
    return { chunks: [first], totalChunks }
  }

  // ---- Editing ---------------------------------------------------------------

  /** Record a draft edit for the given page (unsaved until save succeeds). */
  setPageDraft(index: number, content: string): void {
    this.dirtyPages.set(index, content)
  }

  get hasDirtyPages(): boolean {
    return this.dirtyPages.size > 0
  }

  get dirtyPageCount(): number {
    return this.dirtyPages.size
  }

  /**
   * Reassemble the FULL document exactly as it would be saved, streaming
   * pages in order. Fetches only what is neither dirty nor cached, so peak
   * memory stays at roughly one copy plus the working set.
   */
  async assembleForSave(): Promise<string> {
    if (!(this.totalChunks > 0)) throw new Error("not-ready")
    let acc = ""
    for (let i = 0; i < this.totalChunks; i += 1) {
      const dirty = this.dirtyPages.get(i)
      if (typeof dirty === "string") {
        acc += dirty
        continue
      }
      const cached = this.cleanPages.get(i)
      if (typeof cached === "string") {
        acc += cached
        continue
      }
      if (typeof this.client.getFileChunk !== "function") {
        throw new Error(`chunk-${i}-unavailable`)
      }
      const response = await this.client.getFileChunk(this.fileId, i)
      if (!response || typeof response.content !== "string") {
        throw new Error(`chunk-${i}-unavailable`)
      }
      acc += response.content
    }
    return acc
  }

  /**
   * Called after a successful POST /files/:id/edit: drafts were persisted,
   * so every dirty page becomes the authoritative clean content.
   */
  commitSave(assembled?: string): void {
    this.dirtyPages.clear()
    this.cleanPages.clear()
    if (typeof assembled === "string") this.cleanPages.set(0, assembled)
  }
}
