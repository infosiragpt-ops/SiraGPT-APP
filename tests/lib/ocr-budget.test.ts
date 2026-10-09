import { describe, it, expect } from 'vitest'
import { boundedOcrDimensions, OCR_MAX_PIXELS, OCR_MAX_EDGE, createOcrMemo, createOcrScheduler } from '@/lib/chat/ocr-budget'

describe('OCR resource budget', () => {
  it('bounds large photos, retry scales and extreme aspect ratios while retaining tiny-text enlargement', () => {
    for (const [w,h,scale] of [[6000,4000,3],[6000,4000,5],[200000,2,4],[1600,900,3]]) {
      const size = boundedOcrDimensions(w,h,scale)
      expect(size.width * size.height).toBeLessThanOrEqual(OCR_MAX_PIXELS)
      expect(Math.max(size.width,size.height)).toBeLessThanOrEqual(OCR_MAX_EDGE)
    }
    expect(boundedOcrDimensions(610,94,4)).toEqual({ width:2440, height:376, scale:4 })
    expect(() => boundedOcrDimensions(Infinity,4,2)).toThrow()
  })
  it('does not start another WASM worker until the first terminates, including failures', async () => {
    const schedule = createOcrScheduler(1)
    let release!: () => void
    let active = 0, peak = 0, started = 0
    const first = schedule(async () => { started++; peak=Math.max(peak,++active); await new Promise<void>(r => {release=r}); active--; throw new Error('worker_failed') })
    const rejected = first.catch(() => {})
    const second = schedule(async () => { started++; peak=Math.max(peak,++active); active--; return 2 })
    await Promise.resolve(); await Promise.resolve()
    expect(started).toBe(1)
    release(); await rejected
    expect(await second).toBe(2); expect(peak).toBe(1)
  })
  it('shares work across upload/send for the same File, not another attachment; retries failed work', async () => {
    const memo=createOcrMemo<number>(), file={}, other={}; let calls=0
    const work=async () => ++calls
    const a=memo(file,'72',work), b=memo(file,'72',work)
    expect(a).toBe(b); expect(await a).toBe(1)
    expect(await memo(other,'72',work)).toBe(2)
    await expect(memo(file,'fail',async () => {throw new Error('offline')})).rejects.toThrow('offline')
    expect(await memo(file,'fail',work)).toBe(3)
  })
})
