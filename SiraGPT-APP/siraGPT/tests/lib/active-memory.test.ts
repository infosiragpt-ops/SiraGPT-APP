import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ActiveMemory,
  InMemoryActiveMemoryStore,
  computeEtag,
  type HistoryEntry,
  type AdminScope,
} from '../../backend/src/memory/active'

const mkHist = (n: number): HistoryEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `message body ${i} `.repeat(4),
    tokens: 8,
  }))

const adminScope: AdminScope = { actorId: 'root', isAdmin: true }
const userScope: AdminScope = { actorId: 'u1', isAdmin: false }

describe('ActiveMemory', () => {
  let store: InMemoryActiveMemoryStore
  let mem: ActiveMemory

  beforeEach(() => {
    store = new InMemoryActiveMemoryStore()
    mem = new ActiveMemory(store, {
      maxTokens: 64,
      targetTokens: 48,
      defaultEnabled: true,
      envReader: () => undefined,
    })
  })

  describe('etag', () => {
    it('produces stable hash for identical history', () => {
      const h = mkHist(5)
      expect(computeEtag(h)).toBe(computeEtag(h))
    })

    it('changes when history mutates', () => {
      const a = mkHist(5)
      const b = mkHist(5)
      b[2] = { ...b[2], content: 'edited' }
      expect(computeEtag(a)).not.toBe(computeEtag(b))
    })

    it('changes when history shrinks', () => {
      const big = mkHist(10)
      const small = big.slice(0, 6)
      expect(computeEtag(big)).not.toBe(computeEtag(small))
    })
  })

  describe('shrink invalidation (strong consistency)', () => {
    it('rebuilds snapshot when history shrinks', async () => {
      const big = mkHist(12)
      const r1 = await mem.resolve('u', 's', big)
      expect(r1).not.toBeNull()
      expect(r1!.sourceLength).toBe(12)
      const etag1 = r1!.etag

      // Shrink: user rewinds the conversation.
      const small = big.slice(0, 5)
      const r2 = await mem.resolve('u', 's', small)
      expect(r2).not.toBeNull()
      expect(r2!.sourceLength).toBe(5)
      expect(r2!.etag).not.toBe(etag1)
      // Snapshot must reflect the truncated history — older trailing entries gone.
      expect(r2!.snapshot.includes('message body 11')).toBe(false)
    })

    it('reuses cached snapshot when history is unchanged', async () => {
      const h = mkHist(6)
      const r1 = await mem.resolve('u', 's', h)
      const putSpy = vi.spyOn(store, 'put')
      const r2 = await mem.resolve('u', 's', h)
      expect(r2!.etag).toBe(r1!.etag)
      expect(r2!.updatedAt).toBe(r1!.updatedAt)
      expect(putSpy).not.toHaveBeenCalled()
    })

    it('rebuilds when an entry is edited (same length, different content)', async () => {
      const h1 = mkHist(6)
      const r1 = await mem.resolve('u', 's', h1)
      const h2 = h1.map((e, i) => (i === 3 ? { ...e, content: 'EDITED' } : e))
      const r2 = await mem.resolve('u', 's', h2)
      expect(r2!.etag).not.toBe(r1!.etag)
      expect(r2!.snapshot).toContain('EDITED')
    })

    it('invalidate() forces a rebuild on next resolve', async () => {
      const h = mkHist(4)
      const r1 = await mem.resolve('u', 's', h)
      await mem.invalidate('u', 's')
      const r2 = await mem.resolve('u', 's', h)
      expect(r2!.etag).toBe(r1!.etag) // same source, same etag
      expect(r2!.updatedAt).toBeGreaterThanOrEqual(r1!.updatedAt)
    })
  })

  describe('compactación con clamping', () => {
    it('caps snapshot tokens at maxTokens', async () => {
      const huge = mkHist(50) // 50 * 8 = 400 tokens worth; capped at 64
      const r = await mem.resolve('u', 's', huge)
      expect(r!.tokens).toBeLessThanOrEqual(64)
    })

    it('preserves the most recent context when truncating', async () => {
      const h = mkHist(40)
      const r = await mem.resolve('u', 's', h)
      // The latest message id must appear; oldest must not (under the cap).
      expect(r!.snapshot).toContain('message body 39')
      expect(r!.snapshot).not.toContain('message body 0 ')
    })

    it('hard-clamps even if a custom compactor exceeds maxTokens', async () => {
      const m2 = new ActiveMemory(store, {
        maxTokens: 16,
        targetTokens: 16,
        compactor: () => 'X'.repeat(10000),
        envReader: () => undefined,
      })
      const r = await m2.resolve('u', 's2', mkHist(2))
      expect(r!.tokens).toBeLessThanOrEqual(16)
      expect(r!.snapshot.length).toBeLessThanOrEqual(16 * 4)
    })

    it('handles empty history without throwing', async () => {
      const r = await mem.resolve('u', 'empty', [])
      expect(r).not.toBeNull()
      expect(r!.sourceLength).toBe(0)
      expect(r!.snapshot).toBe('')
      expect(r!.tokens).toBe(0)
    })
  })

  describe('admin scope', () => {
    it('enabled by default when env unset and defaultEnabled=true', () => {
      expect(mem.isEnabled()).toBe(true)
    })

    it('env flag overrides default when no admin override is set', () => {
      const m = new ActiveMemory(store, {
        maxTokens: 32,
        defaultEnabled: true,
        envReader: () => 'false',
      })
      expect(m.isEnabled()).toBe(false)
    })

    it('admin override beats env flag', () => {
      const m = new ActiveMemory(store, {
        maxTokens: 32,
        defaultEnabled: true,
        envReader: () => 'false',
      })
      m.setEnabled(true, adminScope)
      expect(m.isEnabled()).toBe(true)
    })

    it('rejects toggle from non-admin actor', () => {
      expect(() => mem.setEnabled(false, userScope)).toThrowError(/admin clearance/)
      expect(mem.isEnabled()).toBe(true)
    })

    it('returns null from resolve when disabled, without persisting', async () => {
      mem.setEnabled(false, adminScope)
      const r = await mem.resolve('u', 's', mkHist(3))
      expect(r).toBeNull()
      expect(store.size()).toBe(0)
    })

    it('re-enabling causes resolve to rebuild from current history', async () => {
      await mem.resolve('u', 's', mkHist(4))
      mem.setEnabled(false, adminScope)
      expect(await mem.resolve('u', 's', mkHist(4))).toBeNull()
      mem.setEnabled(true, adminScope)
      const r = await mem.resolve('u', 's', mkHist(4))
      expect(r).not.toBeNull()
      expect(r!.sourceLength).toBe(4)
    })
  })

  describe('per-user/per-session isolation', () => {
    it('separates snapshots by user and session', async () => {
      const r1 = await mem.resolve('userA', 's1', mkHist(3))
      const r2 = await mem.resolve('userB', 's1', mkHist(5))
      const r3 = await mem.resolve('userA', 's2', mkHist(3))
      expect(store.size()).toBe(3)
      expect(r1!.etag).toBe(r3!.etag) // same content, different session — recomputed independently
      expect(r1!.sessionId).toBe('s1')
      expect(r3!.sessionId).toBe('s2')
      expect(r2!.userId).toBe('userB')
    })
  })

  describe('constructor validation', () => {
    it('rejects missing store', () => {
      // @ts-expect-error testing invalid input
      expect(() => new ActiveMemory(null, { maxTokens: 10 })).toThrow()
    })
    it('rejects non-positive maxTokens', () => {
      expect(() => new ActiveMemory(store, { maxTokens: 0 })).toThrow()
    })
  })
})
