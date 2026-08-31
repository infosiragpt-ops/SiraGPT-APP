"use client"

import { authenticatedFetch } from "./authenticated-fetch"
import { freshGenerateHeaders } from "./sse-client"
import { lockGeneratePayload } from "./chat/generate-payload"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

export interface PlanResponse {
  plan: any
  dxf: string
}

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export const planService = {
  async generate(brief: string, opts: { model?: string; signal?: AbortSignal } = {}): Promise<PlanResponse> {
    const res = await authenticatedFetch(`${API_ROOT}/plan/generate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...freshGenerateHeaders(), ...authHeader() },
      body: JSON.stringify({ brief, ...lockGeneratePayload(opts.model) }),
      signal: opts.signal,
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try { const j = await res.json(); msg = j.error || msg } catch {}
      throw new Error(msg)
    }
    return res.json()
  },
}
