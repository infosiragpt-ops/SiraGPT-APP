/**
 * document-chunks — pure, string-only helpers for the large-document
 * "paginated editor" mode of DocumentEditorPanel (docs > CHUNKED_MODE_THRESHOLD_CHARS).
 *
 * Contract with the backend endpoint GET /api/files/:id/chunks:
 * the server splits the ACTIVE version's content by paragraphs (\n\n) into
 * chunks of ~TARGET_CHUNK_SIZE characters using EXACTLY this algorithm
 * (mirrored in backend/src/services/document-chunks.js). Both sides must stay
 * in sync so `joinChunks(chunks) === original` holds byte-for-byte across a
 * paginated save.
 *
 * Everything here is pure and dependency-free on purpose: it runs in the
 * browser (client-side reassembly before POST /:id/edit), under vitest/jsdom,
 * AND under plain node --test via the compiled tests bundle. No DOM, no fs,
 * no network.
 */

/** Target size per chunk in UTF-16 chars (~64KB as per the chunked-editor spec). */
export const TARGET_CHUNK_SIZE = 64 * 1024

/**
 * Hard ceiling for one single chunk. A paragraph larger than this is
 * subdivided by lines (and then hard-sliced) so no chunk can blow past
 * the transport budget even on pathological minified input.
 */
export const MAX_CHUNK_SIZE = 96 * 1024

/**
 * Documents whose markdown is at or above this many characters are edited in
 * chunked (paged) mode instead of loading the whole thing into one Tiptap doc.
 * ~8MB of Markdown ≈ a 500+ page document; below that the normal single-doc
 * editor is strictly better UX.
 */
export const CHUNKED_MODE_THRESHOLD_CHARS = 8 * 1024 * 1024

export type DocumentChunk = {
  /** 0-based position inside the split. */
  index: number
  /** The verbatim slice of the original document. */
  content: string
}

function pushChunk(out: DocumentChunk[], buffer: string): void {
  if (buffer.length > 0) {
    out.push({ index: out.length, content: buffer })
  }
}

/**
 * Split `content` into chunks that respect the target size WITHOUT ever
 * altering a single character. Guarantees:
 *
 *   1. `joinDocumentChunks(chunkByParagraphs(content)) === content` (EXACT,
 *      including leading/trailing blank lines and \r\n sequences).
 *   2. Every chunk is <= MAX_CHUNK_SIZE chars.
 *   3. Chunks break at paragraph boundaries (\n\n runs) whenever a paragraph
 *      fits within MAX_CHUNK_SIZE; oversized paragraphs fall back to line
 *      boundaries, then to hard slices at exactly MAX_CHUNK_SIZE.
 *   4. Empty input yields a single empty-ish result: zero chunks.
 */
export function chunkByParagraphs(
  content: string,
  targetSize: number = TARGET_CHUNK_SIZE,
  maxSize: number = MAX_CHUNK_SIZE,
): DocumentChunk[] {
  if (typeof content !== "string" || content.length === 0) return []
  const safeMax = Math.max(1, Math.min(maxSize, Math.max(maxSize, targetSize)))
  const effectiveMax = Math.max(1, safeMax)
  const chunks: DocumentChunk[] = []

  // Split into paragraphs while keeping every separator character intact:
  // capture groups make String.split keep the \n\n delimiters as items.
  const parts = content.split(/(\n{2,})/)
  let buffer = ""

  const flushIfOver = (): void => {
    if (buffer.length >= targetSize) {
      pushChunk(chunks, buffer)
      buffer = ""
    }
  }

  for (const part of parts) {
    // A separator or paragraph that fits in the current buffer just appends.
    if (buffer.length + part.length <= effectiveMax) {
      buffer += part
      // Paragraph text reaching the target closes the chunk here so the NEXT
      // part starts a fresh chunk (separators stick to the preceding text).
      if (!/^\n{2,}$/.test(part)) flushIfOver()
      continue
    }

    // Does not fit: close what we have, then place the part on its own.
    pushChunk(chunks, buffer)
    buffer = ""

    if (part.length <= effectiveMax) {
      buffer = part
      if (!/^\n{2,}$/.test(part)) flushIfOver()
      continue
    }

    // Oversized unit (a giant paragraph or a giant separator run — the latter
    // cannot exceed effectiveMax for realistic max values, but stay safe).
    if (/^\n{2,}$/.test(part)) {
      // Subdivide the separator run itself without losing newlines.
      let remaining = part
      while (remaining.length > effectiveMax) {
        pushChunk(chunks, remaining.slice(0, effectiveMax))
        remaining = remaining.slice(effectiveMax)
      }
      buffer = remaining
      continue
    }

    // Giant paragraph → subdivide by lines first.
    const lines = part.split(/(\n)/)
    for (const line of lines) {
      if (buffer.length + line.length <= effectiveMax) {
        buffer += line
        continue
      }
      pushChunk(chunks, buffer)
      buffer = ""
      if (line.length > effectiveMax) {
        // Single line still too big → hard slice at exact boundaries.
        let remainingLine = line
        while (remainingLine.length > effectiveMax) {
          pushChunk(chunks, remainingLine.slice(0, effectiveMax))
          remainingLine = remainingLine.slice(effectiveMax)
        }
        buffer = remainingLine
      } else {
        buffer = line
      }
    }
    flushIfOver()
  }

  pushChunk(chunks, buffer)

  // Renumber defensively (pushChunk already keeps sequential indexes).
  return chunks.map((chunk, i) => ({ index: i, content: chunk.content }))
}

/**
 * Exact inverse of chunkByParagraphs: reassembles the original document with
 * ZERO normalization. This is what the client calls when persisting a paged
 * edit so the POST /files/:id/edit body stays byte-faithful.
 */
export function joinDocumentChunks(chunks: ReadonlyArray<DocumentChunk | string>): string {
  if (!Array.isArray(chunks) || chunks.length === 0) return ""
  let out = ""
  for (const chunk of chunks) {
    const piece = typeof chunk === "string" ? chunk : chunk.content
    if (typeof piece === "string") out += piece
  }
  return out
}

/**
 * True when a document of `charCount` must open in chunked mode. Centralized
 * so the panel, the meta endpoint, and tests all agree on the cutoff.
 */
export function shouldUseChunkedMode(charCount: number): boolean {
  return Number.isFinite(charCount) && charCount >= CHUNKED_MODE_THRESHOLD_CHARS
}

/**
 * Total number of chunks a document will split into, without materializing
 * the split (cheap upper-bound estimate used for UI labels before fetch).
 * The authoritative count comes from the server response (`totalChunks`).
 */
export function estimateTotalChunks(contentLength: number): number {
  if (!Number.isFinite(contentLength) || contentLength <= 0) return 1
  return Math.max(1, Math.ceil(contentLength / TARGET_CHUNK_SIZE))
}
