/**
 * document-draft — localStorage draft store for the /chat document editor.
 *
 * Golden rule of the autosave front: NEVER lose a user edit. While the
 * panel has unconfirmed changes we mirror the markdown into localStorage
 * keyed by (fileId, userId), so a crash / tab kill / network outage can
 * always recover the latest keystrokes.
 *
 * Shape: `{ content, savedAt, baseVersion }`.
 *   - content    — the edited markdown (verbatim, no sanitizing: it came
 *                  from the editor and goes back to the editor).
 *   - savedAt    — epoch ms of the last local persist (newer-wins clock).
 *   - baseVersion— server FileVersion number the draft diverged from
 *                  (0 = original upload). Lets recovery tell "draft newer
 *                  than server" apart from "server already has this".
 *
 * Every accessor is try/catch-guarded: private mode / quota errors must
 * never break editing. Same pattern as hooks/use-chat-draft.ts.
 */

export type DocumentDraft = {
  content: string
  savedAt: number
  /** Server FileVersion this draft started from (0 = original upload). */
  baseVersion: number
}

const STORAGE_PREFIX = "sira:doc-draft:"
const MAX_DRAFT_CHARS = 1_000_000

function storageKey(fileId: string, userId?: string | null): string {
  return `${STORAGE_PREFIX}${userId || "__anon__"}:${fileId}`
}

export function readDocumentDraft(
  fileId: string,
  userId?: string | null,
): DocumentDraft | null {
  if (typeof window === "undefined" || !fileId) return null
  try {
    const raw = window.localStorage.getItem(storageKey(fileId, userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<DocumentDraft> | null
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.content !== "string") return null
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt)) return null
    return {
      content: parsed.content,
      savedAt: parsed.savedAt,
      baseVersion: typeof parsed.baseVersion === "number" && Number.isFinite(parsed.baseVersion)
        ? parsed.baseVersion
        : 0,
    }
  } catch {
    return null
  }
}

/** Persist the draft. Returns the stored savedAt, or null on storage failure. */
export function writeDocumentDraft(
  fileId: string,
  draft: DocumentDraft,
  userId?: string | null,
): number | null {
  if (typeof window === "undefined" || !fileId) return null
  // A multi-MB draft would blow the ~5MB localStorage quota for little
  // value; the size guard mirrors isEditorContentWithinLimits.
  if (draft.content.length > MAX_DRAFT_CHARS) return null
  try {
    window.localStorage.setItem(storageKey(fileId, userId), JSON.stringify(draft))
    return draft.savedAt
  } catch {
    return null
  }
}

/** Remove the draft once the server has durably confirmed the content. */
export function clearDocumentDraft(fileId: string, userId?: string | null): void {
  if (typeof window === "undefined" || !fileId) return
  try {
    window.localStorage.removeItem(storageKey(fileId, userId))
  } catch {
    /* harmless */
  }
}
