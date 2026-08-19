/**
 * Content-hash utilities for attachment deduplication.
 *
 * Primary path uses WebCrypto SHA-256 (`crypto.subtle.digest`); when the
 * subtle API is unavailable (very old browsers / locked-down webviews) it
 * falls back to a pure-JS FNV-1a hash prefixed with `fnv:` so callers can
 * still dedupe, just with a weaker hash.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** FNV-1a 32-bit over raw bytes, returned as zero-padded lowercase hex. */
function fnv1aHex(bytes: Uint8Array): string {
  let hash = FNV_OFFSET_BASIS
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

function getSubtle(): SubtleCrypto | undefined {
  try {
    return globalThis.crypto?.subtle ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Hash a File/Blob by content.
 * SHA-256 hex (64 chars) when WebCrypto is available; otherwise an
 * FNV-1a hex digest prefixed with `fnv:`.
 */
export async function hashFile(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer()
  const subtle = getSubtle()
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', buffer)
      return bufferToHex(digest)
    } catch {
      // Fall through to FNV-1a below (e.g. insecure context throwing).
    }
  }
  return `fnv:${fnv1aHex(new Uint8Array(buffer))}`
}

export interface DedupeResult<T extends File> {
  /** Files whose content hash was not seen before, in original order. */
  unique: T[]
  /** Files whose hash matched `existingHashes` or an earlier file in the batch. */
  duplicates: T[]
  /** Content hash for every input file (including duplicates). */
  hashes: Map<T, string>
}

/**
 * Split a batch of files into unique vs duplicate by content hash.
 * A file is a duplicate when its hash appears in `existingHashes` or in an
 * earlier file of the same batch. Input order is preserved in both lists.
 */
export async function dedupeFiles<T extends File>(
  files: T[],
  existingHashes?: Iterable<string>
): Promise<DedupeResult<T>> {
  const seen = new Set<string>(existingHashes ?? [])
  const unique: T[] = []
  const duplicates: T[] = []
  const hashes = new Map<T, string>()

  for (const file of files) {
    const hash = await hashFile(file)
    hashes.set(file, hash)
    if (seen.has(hash)) {
      duplicates.push(file)
    } else {
      seen.add(hash)
      unique.push(file)
    }
  }

  return { unique, duplicates, hashes }
}

/**
 * Composite dedupe key combining content hash and byte size, making
 * accidental collisions even less likely: `<hash>:<size>`.
 */
export function makeHashKey(hash: string, size: number): string {
  return `${hash}:${size}`
}
