"use client"

// codex/use-codex-health — one cached probe of GET /api/codex/health so the UI
// decides whether to mount the V2 experience (feature 10). /health is public
// and always 200; when `enabled` is false the V2 UI never mounts and /code
// renders exactly as today.

import { useEffect, useState } from "react"
import { codexApi } from "./codex-api"

let cached: boolean | null = null

export function useCodexHealth() {
  const [enabled, setEnabled] = useState<boolean | null>(cached)

  useEffect(() => {
    if (cached !== null) { setEnabled(cached); return }
    let cancelled = false
    codexApi.health()
      .then((h) => { cached = Boolean(h.enabled); if (!cancelled) setEnabled(cached) })
      .catch(() => { cached = false; if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])

  return { enabled, loading: enabled === null }
}

/** Test/reset hook. */
export function _resetCodexHealthCache() { cached = null }
