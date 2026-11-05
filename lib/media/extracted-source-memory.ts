/**
 * The videos whose audio alone reached the server (extracted in the browser,
 * lib/media/client-audio-extract). Attaching one of them again uploads the
 * whole video: that is the way to its frames, subtitles and on-screen text,
 * and what the server's messages tell the user to do («vuelve a adjuntar el
 * mismo video: esta vez se sube completo»).
 *
 * A video is remembered only once its extracted audio uploaded, so removing
 * a chip and attaching the file again before that still extracts it. Per
 * browser, for 24 hours, at most 200 entries. When storage is blocked the
 * memory lasts for this tab.
 */

const STORAGE_KEY = "sira.extracted-sources.v1"
export const EXTRACTED_SOURCE_TTL_MS = 24 * 60 * 60 * 1000
export const EXTRACTED_SOURCE_MAX = 200

type FileLike = { name?: string | null; size?: number | null; lastModified?: number | null }

/** `name|size|lastModified`: the same file picked again from disk, or null when unusable. */
export function sourceFingerprint(file: FileLike | null | undefined): string | null {
  const name = String(file?.name || "")
  const size = Number(file?.size)
  if (!name || !Number.isFinite(size) || size <= 0) return null
  const modified = Number(file?.lastModified)
  return `${name}|${size}|${Number.isFinite(modified) ? modified : 0}`
}

export type ExtractedSourceMemory = {
  has(file: FileLike | null | undefined): boolean
  remember(file: FileLike | null | undefined): void
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

export function createExtractedSourceMemory(opts: { storage?: () => Storage | null; now?: () => number } = {}): ExtractedSourceMemory {
  const getStorage = opts.storage ?? defaultStorage
  const now = opts.now ?? (() => Date.now())
  const local = new Map<string, number>()

  const fresh = (records: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const [key, savedAt] of Object.entries(records)) {
      if (typeof savedAt === "number" && Number.isFinite(savedAt) && now() - savedAt < EXTRACTED_SOURCE_TTL_MS) out[key] = savedAt
    }
    return out
  }
  const read = (): Record<string, number> => {
    try {
      const raw = getStorage()?.getItem(STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? fresh(parsed as Record<string, number>) : {}
    } catch {
      return {}
    }
  }

  return {
    has(file) {
      const key = sourceFingerprint(file)
      if (!key) return false
      const savedAt = local.get(key)
      if (savedAt !== undefined && now() - savedAt < EXTRACTED_SOURCE_TTL_MS) return true
      return key in read()
    },
    remember(file) {
      const key = sourceFingerprint(file)
      if (!key) return
      const at = now()
      local.set(key, at)
      try {
        const storage = getStorage()
        if (!storage) return
        const entries = Object.entries({ ...read(), [key]: at })
          .sort((a, b) => b[1] - a[1])
          .slice(0, EXTRACTED_SOURCE_MAX)
        storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
      } catch {
        /* storage full or blocked: this tab still remembers */
      }
    },
  }
}

let shared: ExtractedSourceMemory | null = null

/** The browser-wide memory the composer uses. */
export function extractedSourceMemory(): ExtractedSourceMemory {
  if (!shared) shared = createExtractedSourceMemory()
  return shared
}
