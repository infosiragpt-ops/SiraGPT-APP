import { describe, it, expect, afterEach, vi } from 'vitest'
import { hashFile, dedupeFiles, makeHashKey } from '@/lib/attachments/file-hash'

function makeFile(content: string | Uint8Array, name: string): File {
  const part = typeof content === 'string' ? content : (content.slice().buffer as ArrayBuffer)
  return new File([part], name, { type: 'application/octet-stream' })
}

const SHA256_HEX = /^[0-9a-f]{64}$/

describe('hashFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a stable 64-char lowercase hex SHA-256 digest', async () => {
    const a = await hashFile(makeFile('hola mundo', 'a.txt'))
    const b = await hashFile(makeFile('hola mundo', 'b.txt'))
    expect(a).toMatch(SHA256_HEX)
    expect(a).toBe(b)
  })

  it('produces different hashes for different content', async () => {
    const a = await hashFile(makeFile('contenido uno', 'a.txt'))
    const b = await hashFile(makeFile('contenido dos', 'a.txt'))
    expect(a).not.toBe(b)
  })

  it('hashes an empty blob to the well-known SHA-256 of empty input', async () => {
    const hash = await hashFile(new Blob([]))
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('handles a 1MB buffer', async () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const hash = await hashFile(makeFile(bytes, 'big.bin'))
    expect(hash).toMatch(SHA256_HEX)
    // Same content hashes identically regardless of file name.
    const again = await hashFile(makeFile(bytes, 'big-copy.bin'))
    expect(again).toBe(hash)
  })

  it('falls back to FNV-1a with fnv: prefix when crypto.subtle is unavailable', async () => {
    vi.stubGlobal('crypto', {} as Crypto)
    const a = await hashFile(makeFile('sin subtle', 'a.txt'))
    const b = await hashFile(makeFile('sin subtle', 'b.txt'))
    const c = await hashFile(makeFile('otro contenido', 'c.txt'))
    expect(a).toMatch(/^fnv:[0-9a-f]{8}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('dedupeFiles', () => {
  it('marks same content with different names as duplicate', async () => {
    const first = makeFile('mismo contenido', 'informe.txt')
    const second = makeFile('mismo contenido', 'informe-copia.txt')
    const { unique, duplicates, hashes } = await dedupeFiles([first, second])
    expect(unique).toEqual([first])
    expect(duplicates).toEqual([second])
    expect(hashes.get(first)).toBe(hashes.get(second))
  })

  it('keeps files with different content as unique', async () => {
    const a = makeFile('alpha', 'a.txt')
    const b = makeFile('beta', 'b.txt')
    const { unique, duplicates } = await dedupeFiles([a, b])
    expect(unique).toEqual([a, b])
    expect(duplicates).toEqual([])
  })

  it('preserves input order in unique and duplicates', async () => {
    const a = makeFile('uno', 'a.txt')
    const b = makeFile('dos', 'b.txt')
    const aDup = makeFile('uno', 'a2.txt')
    const c = makeFile('tres', 'c.txt')
    const bDup = makeFile('dos', 'b2.txt')
    const { unique, duplicates } = await dedupeFiles([a, b, aDup, c, bDup])
    expect(unique).toEqual([a, b, c])
    expect(duplicates).toEqual([aDup, bDup])
  })

  it('marks files matching existingHashes as duplicates', async () => {
    const a = makeFile('ya subido', 'a.txt')
    const b = makeFile('nuevo', 'b.txt')
    const existing = await hashFile(makeFile('ya subido', 'previo.txt'))
    const { unique, duplicates } = await dedupeFiles([a, b], [existing])
    expect(unique).toEqual([b])
    expect(duplicates).toEqual([a])
  })

  it('returns empty results for an empty list', async () => {
    const { unique, duplicates, hashes } = await dedupeFiles([])
    expect(unique).toEqual([])
    expect(duplicates).toEqual([])
    expect(hashes.size).toBe(0)
  })

  it('records a hash for every input file, including duplicates', async () => {
    const a = makeFile('x', 'a.txt')
    const b = makeFile('x', 'b.txt')
    const c = makeFile('y', 'c.txt')
    const { hashes } = await dedupeFiles([a, b, c])
    expect(hashes.size).toBe(3)
    expect(hashes.get(a)).toMatch(SHA256_HEX)
    expect(hashes.get(c)).toMatch(SHA256_HEX)
  })
})

describe('makeHashKey', () => {
  it('builds the hash:size composite key', () => {
    expect(makeHashKey('abc123', 42)).toBe('abc123:42')
  })

  it('distinguishes equal hashes with different sizes', () => {
    expect(makeHashKey('deadbeef', 10)).not.toBe(makeHashKey('deadbeef', 11))
  })
})
