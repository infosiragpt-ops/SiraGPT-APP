// Bound the expensive WASM/canvas work across both upload and send paths.
export const OCR_MAX_PIXELS = 2_000_000
export const OCR_MAX_EDGE = 4096

export function boundedOcrDimensions(width: number, height: number, requestedScale: number) {
  if (![width, height, requestedScale].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('invalid_ocr_dimensions')
  }
  const scale = Math.min(requestedScale, Math.sqrt(OCR_MAX_PIXELS / (width * height)), OCR_MAX_EDGE / Math.max(width, height))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale }
}

export function createOcrScheduler(concurrency = 1) {
  let active = 0
  const waiting: Array<() => void> = []
  return async function schedule<T>(work: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      const start = () => { active++; resolve() }
      if (active < Math.max(1, concurrency)) start()
      else waiting.push(start)
    })
    try { return await work() }
    finally { active--; waiting.shift()?.() }
  }
}

/** Weak keys keep results shared while an attachment lives, never beyond it. */
export function createOcrMemo<T>() {
  const cache = new WeakMap<object, Map<string, Promise<T>>>()
  return (source: object, variant: string, work: () => Promise<T>): Promise<T> => {
    let variants = cache.get(source)
    if (!variants) { variants = new Map(); cache.set(source, variants) }
    const existing = variants.get(variant)
    if (existing) return existing
    const promise = Promise.resolve().then(work).catch(error => {
      variants!.delete(variant)
      throw error
    })
    variants.set(variant, promise)
    return promise
  }
}
