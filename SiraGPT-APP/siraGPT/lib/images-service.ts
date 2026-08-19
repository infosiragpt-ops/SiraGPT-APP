"use client"

/**
 * images-service — client for /api/images/* (F4 PR15).
 *
 * Drives the F3 PR16 history panel + the per-image actions bar
 * (re-roll, variation, upscale, delete). Polls a single job until
 * its status is terminal (READY / FAILED / MODERATED) so the UI can
 * stream progress without a websocket.
 */

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export type ImageStatus =
  | "PENDING"
  | "RUNNING"
  | "READY"
  | "FAILED"
  | "MODERATED"

export type ImageKind = "original" | "variation" | "upscale"

export interface GeneratedImage {
  id: string
  userId: string
  chatId: string | null
  messageId: string | null
  prompt: string
  negativePrompt: string | null
  provider: string
  model: string
  size: string
  n: number
  seed: string | null
  quality: string | null
  style: string | null
  status: ImageStatus
  costCredits: string
  errorMessage: string | null
  assetIds: string[]
  parentImageId: string | null
  kind: ImageKind
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

interface HistoryResponse {
  images: GeneratedImage[]
  nextCursor: string | null
}

interface JobResponse {
  image: GeneratedImage
  charge?: { amount: string; transactionId: string } | null
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {}
  const token = window.localStorage.getItem("auth-token")
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface CreateImageJobInput {
  prompt: string
  size?: string
  n?: number
  negativePrompt?: string
  style?: string
  quality?: string
  model?: string
  provider?: "mock" | "openai" | "none"
  chatId?: string
  messageId?: string
}

export async function createImageJob(input: CreateImageJobInput): Promise<JobResponse> {
  const res = await fetch(`${API_ROOT}/images/jobs`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(input),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data?.error || `createImageJob (${res.status})`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return data as JobResponse
}

export async function getImageJob(id: string): Promise<GeneratedImage> {
  const res = await fetch(`${API_ROOT}/images/jobs/${id}`, {
    headers: authHeader(),
  })
  if (!res.ok) throw new Error(`getImageJob(${id}): ${res.status}`)
  const data = (await res.json()) as { image: GeneratedImage }
  return data.image
}

export async function listImageHistory(opts?: {
  cursor?: string | null
  limit?: number
}): Promise<HistoryResponse> {
  const qs = new URLSearchParams()
  if (opts?.cursor) qs.set("cursor", opts.cursor)
  if (opts?.limit) qs.set("limit", String(opts.limit))
  const res = await fetch(
    `${API_ROOT}/images/history${qs.toString() ? `?${qs}` : ""}`,
    { headers: authHeader() },
  )
  if (!res.ok) throw new Error(`listImageHistory: ${res.status}`)
  return (await res.json()) as HistoryResponse
}

export async function requestVariation(id: string, n = 1): Promise<JobResponse> {
  const res = await fetch(`${API_ROOT}/images/${id}/variations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ n }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `requestVariation (${res.status})`)
  return data as JobResponse
}

export async function requestUpscale(id: string, factor: 2 | 4 = 2): Promise<JobResponse> {
  const res = await fetch(`${API_ROOT}/images/${id}/upscale`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ factor }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `requestUpscale (${res.status})`)
  return data as JobResponse
}

export async function deleteImage(id: string): Promise<GeneratedImage> {
  const res = await fetch(`${API_ROOT}/images/${id}/delete`, {
    method: "POST",
    credentials: "include",
    headers: authHeader(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `deleteImage (${res.status})`)
  return (data as { image: GeneratedImage }).image
}

/**
 * Polls `getImageJob(id)` until status is terminal or `maxAttempts` is
 * reached. Backs off linearly (1s, 2s, 3s, capped at 4s) so a fast
 * provider returns in ~1s and a slow one doesn't spam the API.
 */
export async function pollImageJob(
  id: string,
  opts: { signal?: AbortSignal; maxAttempts?: number } = {},
): Promise<GeneratedImage> {
  const max = opts.maxAttempts ?? 30
  for (let attempt = 0; attempt < max; attempt += 1) {
    if (opts.signal?.aborted) throw new Error("aborted")
    const image = await getImageJob(id)
    if (
      image.status === "READY" ||
      image.status === "FAILED" ||
      image.status === "MODERATED"
    ) {
      return image
    }
    const waitMs = Math.min(1000 * (attempt + 1), 4000)
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs)
      if (opts.signal) {
        opts.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve(undefined)
          },
          { once: true },
        )
      }
    })
  }
  throw new Error(`pollImageJob(${id}): timed out`)
}

export function isTerminalStatus(s: ImageStatus): boolean {
  return s === "READY" || s === "FAILED" || s === "MODERATED"
}
