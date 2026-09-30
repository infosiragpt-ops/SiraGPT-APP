"use client"

import { useEffect, useState } from "react"
import { apiClient } from "@/lib/api"

/**
 * Whether the user's persistent memory has anything for SiraGPT to use —
 * the light-blue «Memoria activa» check (claude.ai style) in the composer
 * menu and in Ajustes → Memoria reads from here. One fetch per page load,
 * shared by every subscriber; `refreshMemoryStatus()` after edits.
 */
export type MemoryStatus = { active: boolean; count: number; loaded: boolean }

export const MEMORY_STATUS_EVENT = "sira:memory-status"

let cached: MemoryStatus = { active: false, count: 0, loaded: false }
let inFlight: Promise<MemoryStatus> | null = null

function publish(next: MemoryStatus) {
  cached = next
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<MemoryStatus>(MEMORY_STATUS_EVENT, { detail: next }))
}

export async function refreshMemoryStatus(): Promise<MemoryStatus> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const data = await apiClient.getMemory()
      const count = Number(data?.stats?.total ?? (Array.isArray(data?.entries) ? data.entries.length : 0)) || 0
      publish({ active: count > 0, count, loaded: true })
    } catch {
      publish({ ...cached, loaded: true })
    } finally {
      inFlight = null
    }
    return cached
  })()
  return inFlight
}

/** Let a caller that just changed the memory report the new count directly. */
export function setMemoryStatusCount(count: number): void {
  publish({ active: count > 0, count: Math.max(0, count), loaded: true })
}

export function useMemoryStatus(enabled = true): MemoryStatus {
  const [status, setStatus] = useState<MemoryStatus>(cached)
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return
    const onChange = (event: Event) => setStatus((event as CustomEvent<MemoryStatus>).detail)
    window.addEventListener(MEMORY_STATUS_EVENT, onChange)
    if (!cached.loaded) void refreshMemoryStatus()
    else setStatus(cached)
    return () => window.removeEventListener(MEMORY_STATUS_EVENT, onChange)
  }, [enabled])
  return status
}

/** Test seam. */
export function _resetMemoryStatusForTests(): void {
  cached = { active: false, count: 0, loaded: false }
  inFlight = null
}
