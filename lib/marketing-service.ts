"use client"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: any = null
    try { body = await res.json() } catch {}
    const msg = body?.error || body?.message || `HTTP ${res.status}`
    const err: any = new Error(msg)
    err.status = res.status
    err.body = body
    throw err
  }
  return res.json() as Promise<T>
}

export type Platform = "facebook" | "instagram" | "youtube" | "tiktok" | "linkedin"
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled"
export type Cadence = "daily" | "weekly" | "every-2-days"

export interface ReferenceImage {
  name: string
  dataUrl: string
  size?: number
  type?: string
}

export interface ScheduledPost {
  id: string
  prompt: string
  caption: string | null
  imageUrl: string | null
  imageModel: string | null
  platforms: Platform[]
  scheduledAt: string | null
  status: PostStatus
  publishedAt?: string | null
  lastError?: string | null
  config?: any
  referenceImages?: ReferenceImage[] | null
  batchId?: string | null
  createdAt: string
  updatedAt: string
}

export interface GenerateImageInput {
  prompt: string
  model?: string
  orientation?: "cuadrado" | "vertical" | "horizontal"
  color?: string
  animation?: string
  price?: string
  platforms?: Platform[]
}

export interface ConnectionStatus {
  configured: boolean
  connected: boolean
  accountName: string | null
  profile: any | null
}
export type ConnectionsStatus = Record<Platform, ConnectionStatus>

export interface BatchInput {
  prompt: string
  count: number
  cadence?: Cadence
  startDate: string                // ISO
  timeOfDay?: string               // HH:MM
  platforms: Platform[]
  model?: string
  orientation?: "cuadrado" | "vertical" | "horizontal"
  palette?: string
  animation?: string
  price?: string
  referenceImages?: ReferenceImage[]
  generateImages?: boolean
}

export const marketingService = {
  async generateImage(input: GenerateImageInput) {
    const res = await fetch(`${API_ROOT}/marketing/generate-image`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(input),
    })
    return handle<{ imageUrl: string; model: string; prompt: string; size: string }>(res)
  },

  async savePost(post: Partial<ScheduledPost>): Promise<ScheduledPost> {
    const res = await fetch(`${API_ROOT}/marketing/posts`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(post),
    })
    const j = await handle<{ post: ScheduledPost }>(res)
    return j.post
  },

  async listPosts(): Promise<ScheduledPost[]> {
    const res = await fetch(`${API_ROOT}/marketing/posts`, {
      credentials: "include", headers: { ...authHeader() },
    })
    const j = await handle<{ posts: ScheduledPost[] }>(res)
    return j.posts
  },

  async updatePost(id: string, patch: Partial<ScheduledPost>): Promise<ScheduledPost> {
    const res = await fetch(`${API_ROOT}/marketing/posts/${id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(patch),
    })
    const j = await handle<{ post: ScheduledPost }>(res)
    return j.post
  },

  async deletePost(id: string): Promise<void> {
    const res = await fetch(`${API_ROOT}/marketing/posts/${id}`, {
      method: "DELETE", credentials: "include", headers: { ...authHeader() },
    })
    await handle(res)
  },

  async batchSchedule(input: BatchInput) {
    const res = await fetch(`${API_ROOT}/marketing/posts/batch`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(input),
    })
    return handle<{ batchId: string; count: number; posts: ScheduledPost[] }>(res)
  },

  async suggestPalettes(vibe: string): Promise<Palette[]> {
    if (!vibe.trim()) return []
    const res = await fetch(`${API_ROOT}/marketing/palette-suggestions?vibe=${encodeURIComponent(vibe)}`, {
      credentials: "include", headers: { ...authHeader() },
    })
    const j = await handle<{ palettes: Palette[] }>(res)
    return j.palettes || []
  },

  async listConnections() {
    const res = await fetch(`${API_ROOT}/marketing/connections`, {
      credentials: "include", headers: { ...authHeader() },
    })
    return handle<{ connections: any[]; status: ConnectionsStatus }>(res)
  },

  async startConnect(platform: Platform) {
    const res = await fetch(`${API_ROOT}/marketing/connections/${platform}/start`, {
      method: "POST", credentials: "include",
      headers: { ...authHeader() },
    })
    return handle<{ url: string; state: string }>(res)
  },

  async disconnect(platform: Platform) {
    const res = await fetch(`${API_ROOT}/marketing/connections/${platform}`, {
      method: "DELETE", credentials: "include", headers: { ...authHeader() },
    })
    await handle(res)
  },
}

export const PLATFORMS: { id: Platform; label: string; color: string; hint: string }[] = [
  { id: "facebook",  label: "Facebook",  color: "#1877F2", hint: "Post con imagen" },
  { id: "instagram", label: "Instagram", color: "#E4405F", hint: "Feed · 1:1 o 4:5" },
  { id: "youtube",   label: "YouTube",   color: "#FF0000", hint: "Short · 9:16" },
  { id: "tiktok",    label: "TikTok",    color: "#111111", hint: "Video corto · 9:16" },
  { id: "linkedin",  label: "LinkedIn",  color: "#0A66C2", hint: "Post profesional" },
]

export const DEFAULT_MODEL = "openai/gpt-5.4-image-2"

// ─── Color palettes ───────────────────────────────────────────────────────
//
// User describes the vibe in free text; the backend's
// /palette-suggestions endpoint returns 4 AI-proposed palettes from
// which the user picks one. If none is picked the raw description
// flows straight into the image-generation prompt.

export interface Palette {
  id: string
  name: string
  vibe: string          // short descriptor passed to the image model
  swatches: string[]    // 4 hex tones, left→right
}
