"use client"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try { const j = await res.json(); msg = j.error || msg } catch {}
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export type Platform = "facebook" | "instagram" | "youtube" | "tiktok" | "linkedin"
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled"

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

export const marketingService = {
  async generateImage(input: GenerateImageInput): Promise<{ imageUrl: string; model: string; prompt: string; size: string }> {
    const res = await fetch(`${API_ROOT}/marketing/generate-image`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(input),
    })
    return handle<any>(res)
  },

  async savePost(post: Partial<ScheduledPost>): Promise<ScheduledPost> {
    const res = await fetch(`${API_ROOT}/marketing/posts`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(post),
    })
    const j = await handle<{ post: ScheduledPost }>(res)
    return j.post
  },

  async listPosts(): Promise<ScheduledPost[]> {
    const res = await fetch(`${API_ROOT}/marketing/posts`, {
      credentials: "include",
      headers: { ...authHeader() },
    })
    const j = await handle<{ posts: ScheduledPost[] }>(res)
    return j.posts
  },

  async updatePost(id: string, patch: Partial<ScheduledPost>): Promise<ScheduledPost> {
    const res = await fetch(`${API_ROOT}/marketing/posts/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(patch),
    })
    const j = await handle<{ post: ScheduledPost }>(res)
    return j.post
  },

  async deletePost(id: string): Promise<void> {
    const res = await fetch(`${API_ROOT}/marketing/posts/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: { ...authHeader() },
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
