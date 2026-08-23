/**
 * Client OCR preprocess + optional Tesseract first pass.
 *
 * Used on /chat image attachments BEFORE the model answers:
 *   1. Upscale 3–4× on a canvas (tiny banners like 610×94 need this)
 *   2. Adaptive threshold / binarize
 *   3. Deskew via projection-profile
 *   4. Optional Tesseract.js read
 *   5. Auto-retry at a larger scale when confidence is low
 */

export const OCR_LOW_CONFIDENCE = 72
export const OCR_MIN_USEFUL_CHARS = 8
export const OCR_PLACEHOLDER_RE =
  /^(no text found in image|no text detected(?: in image pdf)?|no content available|binary file|file content could not be extracted)/i

export type GrayBuffer = { data: Uint8ClampedArray; width: number; height: number }

export type OcrPreprocessResult = {
  blob: Blob
  width: number
  height: number
  scale: number
  angle: number
}

export type ClientOcrResult = {
  text: string
  confidence: number
  retries: number
  scale: number
  usefulChars: number
  accepted: boolean
}

export function usefulOcrCharCount(text: string): number {
  const matches = String(text || "").match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/g)
  return matches ? matches.length : 0
}

export function normalizeOcrText(text: string): string {
  return String(text || "")
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function isWeakOcrText(text: unknown, confidence?: number): boolean {
  const normalized = normalizeOcrText(String(text || ""))
  if (!normalized || OCR_PLACEHOLDER_RE.test(normalized)) return true
  if (usefulOcrCharCount(normalized) < OCR_MIN_USEFUL_CHARS) return true
  if (typeof confidence === "number" && confidence < OCR_LOW_CONFIDENCE) return true
  return false
}

/** Tiny banners (URL strips, stamps) get 4×; typical photos stay at 3×. */
export function pickUpscaleFactor(width: number, height: number): number {
  const minSide = Math.min(width, height)
  const maxSide = Math.max(width, height)
  const area = width * height
  if (minSide > 0 && (minSide < 160 || maxSide < 720 || area < 90_000)) return 4
  return 3
}

export function shouldRetryOcr(confidence: number, usefulChars: number): boolean {
  if (usefulChars < OCR_MIN_USEFUL_CHARS) return true
  return confidence < OCR_LOW_CONFIDENCE
}

export function looksLikeTranscriptionRequest(text: string): boolean {
  return /(?:transcrib\w*|ocr\b|lee(?:r)?\s+(?:el|la|este|esta)\s+(?:texto|imagen|captura)|qu[eé]\s+dice)/i.test(
    String(text || ""),
  )
}

/**
 * Sauvola-style adaptive threshold on a grayscale buffer (1 byte / pixel).
 * Mutates `data` in place and returns it.
 */
export function applyAdaptiveThreshold(
  gray: GrayBuffer,
  opts: { window?: number; k?: number } = {},
): GrayBuffer {
  const { width, height, data } = gray
  const window = Math.max(7, Math.min(31, opts.window ?? 15))
  const k = opts.k ?? 0.18
  const radius = Math.floor(window / 2)
  const out = new Uint8ClampedArray(data.length)
  const integral = new Float64Array((width + 1) * (height + 1))
  const integralSq = new Float64Array((width + 1) * (height + 1))

  for (let y = 1; y <= height; y += 1) {
    let row = 0
    let rowSq = 0
    for (let x = 1; x <= width; x += 1) {
      const v = data[(y - 1) * width + (x - 1)]
      row += v
      rowSq += v * v
      const idx = y * (width + 1) + x
      integral[idx] = integral[idx - (width + 1)] + row
      integralSq[idx] = integralSq[idx - (width + 1)] + rowSq
    }
  }

  const sumAt = (buf: Float64Array, x: number, y: number) => {
    const cx = Math.max(0, Math.min(width, x))
    const cy = Math.max(0, Math.min(height, y))
    return buf[cy * (width + 1) + cx]
  }
  const rect = (buf: Float64Array, x0: number, y0: number, x1: number, y1: number) =>
    sumAt(buf, x1, y1) - sumAt(buf, x0, y1) - sumAt(buf, x1, y0) + sumAt(buf, x0, y0)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x0 = x - radius
      const y0 = y - radius
      const x1 = x + radius + 1
      const y1 = y + radius + 1
      const count = Math.max(1, (Math.min(width, x1) - Math.max(0, x0)) * (Math.min(height, y1) - Math.max(0, y0)))
      const mean = rect(integral, x0, y0, x1, y1) / count
      const meanSq = rect(integralSq, x0, y0, x1, y1) / count
      const variance = Math.max(0, meanSq - mean * mean)
      const std = Math.sqrt(variance)
      // Uniform patches have no local contrast — classify by mean so a
      // dark URL strip does not flip to white (classic Sauvola pitfall).
      if (std < 8) {
        out[y * width + x] = mean < 128 ? 0 : 255
        continue
      }
      const threshold = mean * (1 + k * (std / 128 - 1))
      out[y * width + x] = data[y * width + x] > threshold ? 255 : 0
    }
  }
  gray.data.set(out)
  return gray
}

/**
 * Projection-profile deskew estimate in [-8, 8] degrees.
 * Higher row-variance ⇒ more horizontal text alignment.
 */
export function estimateDeskewAngle(gray: GrayBuffer): number {
  const { width, height, data } = gray
  if (width < 8 || height < 8) return 0
  let bestAngle = 0
  let bestScore = -1
  for (let angle = -8; angle <= 8; angle += 1) {
    const rad = (angle * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const projections = new Float64Array(height)
    for (let y = 0; y < height; y += 1) {
      let row = 0
      for (let x = 0; x < width; x += 4) {
        const sx = Math.round(x * cos - y * sin)
        const sy = Math.round(x * sin + y * cos)
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
        row += 255 - data[sy * width + sx]
      }
      projections[y] = row
    }
    let mean = 0
    for (let i = 0; i < height; i += 1) mean += projections[i]
    mean /= height
    let variance = 0
    for (let i = 0; i < height; i += 1) {
      const d = projections[i] - mean
      variance += d * d
    }
    if (variance > bestScore) {
      bestScore = variance
      bestAngle = angle
    }
  }
  return bestAngle
}

function canvasToBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("canvas_toblob_failed"))
    }, type)
  })
}

function loadImageElement(source: Blob | File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("image_load_failed"))
    }
    img.src = url
  })
}

function grayscaleFromImageData(imageData: ImageData): GrayBuffer {
  const { width, height, data } = imageData
  const gray = new Uint8ClampedArray(width * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    gray[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
  }
  return { data: gray, width, height }
}

function writeGrayToImageData(gray: GrayBuffer, imageData: ImageData) {
  const { data } = imageData
  for (let i = 0, j = 0; i < gray.data.length; i += 1, j += 4) {
    const v = gray.data[i]
    data[j] = v
    data[j + 1] = v
    data[j + 2] = v
    data[j + 3] = 255
  }
}

export async function preprocessImageForOcr(
  source: Blob | File,
  opts: { scale?: number; binarize?: boolean; deskew?: boolean } = {},
): Promise<OcrPreprocessResult> {
  const img = await loadImageElement(source)
  const scale = opts.scale ?? pickUpscaleFactor(img.naturalWidth || img.width, img.naturalHeight || img.height)
  const srcW = img.naturalWidth || img.width
  const srcH = img.naturalHeight || img.height
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("canvas_2d_unavailable")
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(img, 0, 0, width, height)

  const imageData = ctx.getImageData(0, 0, width, height)
  const gray = grayscaleFromImageData(imageData)
  const angle = opts.deskew === false ? 0 : estimateDeskewAngle(gray)
  if (opts.binarize !== false) applyAdaptiveThreshold(gray)

  if (angle !== 0) {
    const rotated = document.createElement("canvas")
    rotated.width = width
    rotated.height = height
    const rctx = rotated.getContext("2d")
    if (rctx) {
      writeGrayToImageData(gray, imageData)
      ctx.putImageData(imageData, 0, 0)
      rctx.fillStyle = "#ffffff"
      rctx.fillRect(0, 0, width, height)
      rctx.translate(width / 2, height / 2)
      rctx.rotate((-angle * Math.PI) / 180)
      rctx.drawImage(canvas, -width / 2, -height / 2)
      const blob = await canvasToBlob(rotated)
      return { blob, width, height, scale, angle }
    }
  }

  writeGrayToImageData(gray, imageData)
  ctx.putImageData(imageData, 0, 0)
  const blob = await canvasToBlob(canvas)
  return { blob, width, height, scale, angle }
}

export async function preprocessImageFile(
  file: File,
  opts: { scale?: number } = {},
): Promise<File> {
  try {
    const result = await preprocessImageForOcr(file, opts)
    const name = file.name.replace(/\.[^.]+$/, "") + "-ocr.png"
    return new File([result.blob], name, { type: "image/png", lastModified: Date.now() })
  } catch {
    return file
  }
}

type TesseractWorkerLike = {
  recognize: (input: Blob | File) => Promise<{ data: { text?: string; confidence?: number } }>
  terminate: () => Promise<unknown>
}

type TesseractModuleLike = {
  createWorker?: (lang?: string) => Promise<TesseractWorkerLike>
}

async function createTesseractWorker(): Promise<TesseractWorkerLike | null> {
  try {
    const mod = await import("tesseract.js")
    const createWorker = (mod as unknown as TesseractModuleLike).createWorker
    if (!createWorker) return null
    return await createWorker("spa+eng")
  } catch {
    return null
  }
}

export async function recognizeImageWithRetry(
  file: File,
  opts: { minConfidence?: number } = {},
): Promise<ClientOcrResult> {
  const minConfidence = opts.minConfidence ?? OCR_LOW_CONFIDENCE
  const worker = await createTesseractWorker()
  if (!worker) {
    return { text: "", confidence: 0, retries: 0, scale: 1, usefulChars: 0, accepted: false }
  }

  const runPass = async (source: Blob | File, scale: number) => {
    const { data } = await worker.recognize(source)
    const text = normalizeOcrText(data?.text || "")
    const confidence = Number(data?.confidence || 0)
    const usefulChars = usefulOcrCharCount(text)
    return {
      text,
      confidence,
      retries: 0,
      scale,
      usefulChars,
      accepted: !isWeakOcrText(text, confidence) && confidence >= minConfidence,
    }
  }

  try {
    const prepared = await preprocessImageForOcr(file)
    let best = await runPass(prepared.blob, prepared.scale)
    let retries = 0
    if (shouldRetryOcr(best.confidence, best.usefulChars) || !best.accepted) {
      retries += 1
      const enlarged = await preprocessImageForOcr(file, { scale: Math.max(4, prepared.scale + 1) })
      const second = await runPass(enlarged.blob, enlarged.scale)
      if (second.usefulChars > best.usefulChars || second.confidence > best.confidence) {
        best = second
      }
    }
    return { ...best, retries }
  } catch {
    return { text: "", confidence: 0, retries: 0, scale: 1, usefulChars: 0, accepted: false }
  } finally {
    try { await worker.terminate() } catch { /* ignore */ }
  }
}

export async function enrichImageFilesWithClientOcr<T extends { file?: File; type?: string; mimeType?: string; extractedText?: unknown; ocr?: { confidence?: number } }>(
  files: T[],
  opts: { force?: boolean; prompt?: string } = {},
): Promise<T[]> {
  const wantsOcr = opts.force || looksLikeTranscriptionRequest(opts.prompt || "")
  if (!wantsOcr && !opts.force) {
    return Promise.all(files.map(async (entry) => {
      if (!isImageEntry(entry)) return entry
      if (!isWeakOcrText(entry.extractedText, entry.ocr?.confidence)) return entry
      return runOne(entry)
    }))
  }
  return Promise.all(files.map(async (entry) => (isImageEntry(entry) ? runOne(entry) : entry)))

  async function runOne(entry: T): Promise<T> {
    const source = entry.file
    if (!(source instanceof File)) return entry
    try {
      const result = await recognizeImageWithRetry(source)
      if (!result.text) return entry
      return {
        ...entry,
        extractedText: result.text,
        ocr: { ...(entry.ocr || {}), confidence: result.confidence, provider: "tesseract.js", clientPreprocess: true, retries: result.retries },
      }
    } catch {
      return entry
    }
  }
}

function isImageEntry(entry: { type?: string; mimeType?: string; file?: File }): boolean {
  const mime = String(entry.mimeType || entry.type || entry.file?.type || "")
  return mime.startsWith("image/")
}
