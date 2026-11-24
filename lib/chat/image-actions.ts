/**
 * Typed event contracts and duration formatting helpers shared between chat
 * image action menus (WhatsApp-style hover menu) and the /agentes composer host.
 */

export const IMAGE_REPLY_EVENT = "siragpt:image-reply"
export const IMAGE_PRECISION_EDIT_EVENT = "siragpt:image-precision-edit"
export const IMAGE_TO_VIDEO_EVENT = "siragpt:image-to-video"
export const IMAGE_FORWARD_EVENT = "siragpt:image-forward"

export interface ChatImageActionPayload {
  id: string
  fileId?: string
  url: string
  name: string
  prompt?: string
  aspectRatio?: string
  chatId?: string
  messageId?: string
  width?: number
  height?: number
  model?: string
  provider?: string
  quality?: string
}

export interface ImageToVideoEventDetail extends ChatImageActionPayload {
  durationSeconds: number
}

export interface ImageForwardEventDetail extends ChatImageActionPayload {
  mode: "new-chat" | "pick-chat"
}

export const VIDEO_DURATION_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "5 s", seconds: 5 },
  { label: "8 s", seconds: 8 },
  { label: "10 s", seconds: 10 },
  { label: "15 s", seconds: 15 },
  { label: "30 s", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "2 min", seconds: 120 },
]

export const MIN_EXTENDED_VIDEO_SECONDS = 4
export const MAX_EXTENDED_VIDEO_SECONDS = 300

export function parseCustomVideoDuration(value: string | number, unit: "seconds" | "minutes"): number | null {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value).replace(",", ".").trim())
  if (!Number.isFinite(num) || num <= 0) return null
  const seconds = Math.round(unit === "minutes" ? num * 60 : num)
  if (seconds < MIN_EXTENDED_VIDEO_SECONDS) return MIN_EXTENDED_VIDEO_SECONDS
  return Math.min(MAX_EXTENDED_VIDEO_SECONDS, seconds)
}

export function formatVideoDurationEs(seconds: number): string {
  const s = Math.max(1, Math.round(Number(seconds) || 0))
  if (s < 60) return `${s} s`
  const mins = Math.floor(s / 60)
  const rem = s % 60
  if (rem === 0) return `${mins} min`
  return `${mins} min ${rem} s`
}

export function dispatchImageReply(payload: ChatImageActionPayload) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<ChatImageActionPayload>(IMAGE_REPLY_EVENT, { detail: payload }))
}

export function dispatchImagePrecisionEdit(payload: ChatImageActionPayload) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<ChatImageActionPayload>(IMAGE_PRECISION_EDIT_EVENT, { detail: payload }))
}

export function dispatchImageToVideo(payload: ImageToVideoEventDetail) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<ImageToVideoEventDetail>(IMAGE_TO_VIDEO_EVENT, { detail: payload }))
}

export function dispatchImageForward(payload: ImageForwardEventDetail) {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent<ImageForwardEventDetail>(IMAGE_FORWARD_EVENT, { detail: payload }))
}
