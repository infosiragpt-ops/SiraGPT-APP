export interface ImageViewerPoint { x: number; y: number }
export interface ImageViewerSelection extends ImageViewerPoint { width: number; height: number }
export interface ImageViewerStroke { points: ImageViewerPoint[]; color: string; width: number }
export interface ImageViewerComment extends ImageViewerPoint { id: string; text: string }

/** Percent coordinates keep the edit target independent of viewport and zoom. */
export function imagePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): ImageViewerPoint {
  const clamp = (value: number) => Math.max(0, Math.min(100, value))
  return { x: clamp(((clientX - rect.left) / Math.max(1, rect.width)) * 100), y: clamp(((clientY - rect.top) / Math.max(1, rect.height)) * 100) }
}

export function imageSelection(a: ImageViewerPoint, b: ImageViewerPoint): ImageViewerSelection {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

export function imageFitScale(width: number, height: number, viewportWidth: number, viewportHeight: number): number {
  if (![width, height, viewportWidth, viewportHeight].every(n => Number.isFinite(n) && n > 0)) return 1
  return Math.min(1, viewportWidth / width, viewportHeight / height)
}

export function clampImagePan(pan: ImageViewerPoint, width: number, height: number, viewportWidth: number, viewportHeight: number): ImageViewerPoint {
  const maxX = Math.max(0, (width - viewportWidth) / 2)
  const maxY = Math.max(0, (height - viewportHeight) / 2)
  return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) }
}

/** Transparent pixels identify the edit region; exterior pixels remain opaque. */
export function imageSelectionMask(width: number, height: number, selection: ImageViewerSelection): string {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Tu navegador no permite preparar la selección. Prueba con otro navegador.")
  ctx.fillStyle = "#000"
  ctx.fillRect(0, 0, width, height)
  ctx.clearRect(Math.floor(selection.x * width / 100), Math.floor(selection.y * height / 100), Math.ceil(selection.width * width / 100), Math.ceil(selection.height * height / 100))
  return canvas.toDataURL("image/png")
}

export async function readImageViewerBlob(url: string): Promise<Blob> {
  const { authenticatedFetch } = await import("./authenticated-fetch")
  const response = await authenticatedFetch(url)
  if (!response.ok) throw new Error("No se pudo leer la imagen original. Vuelve a abrirla e inténtalo de nuevo.")
  const blob = await response.blob()
  if (!blob.type.startsWith("image/")) throw new Error("El archivo original no es una imagen disponible.")
  return blob
}

/** Use local bytes so canvas never exports a tainted cross-origin image. */
export async function rasterizeImageAnnotations(url: string, strokes: ImageViewerStroke[]): Promise<string> {
  const objectUrl = URL.createObjectURL(await readImageViewerBlob(url))
  try {
    const source = new Image()
    await new Promise<void>((resolve, reject) => {
      source.onload = () => resolve()
      source.onerror = () => reject(new Error("No se pudo abrir la imagen para guardar las anotaciones."))
      source.src = objectUrl
    })
    const canvas = document.createElement("canvas")
    canvas.width = source.naturalWidth
    canvas.height = source.naturalHeight
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Tu navegador no permite guardar anotaciones.")
    ctx.drawImage(source, 0, 0)
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    for (const stroke of strokes) {
      if (!stroke.points.length) continue
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = Math.max(1, stroke.width * canvas.width / 100)
      ctx.beginPath()
      ctx.moveTo(stroke.points[0].x * canvas.width / 100, stroke.points[0].y * canvas.height / 100)
      for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * canvas.width / 100, point.y * canvas.height / 100)
      if (stroke.points.length === 1) ctx.lineTo(stroke.points[0].x * canvas.width / 100 + 0.1, stroke.points[0].y * canvas.height / 100)
      ctx.stroke()
    }
    return canvas.toDataURL("image/png")
  } finally { URL.revokeObjectURL(objectUrl) }
}
