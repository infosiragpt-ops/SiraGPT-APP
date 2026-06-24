"use client"

// codex/use-codex-health — one cached probe of GET /api/codex/health so the UI
// decides whether to mount the V2 experience (feature 10). /health is public
// and always 200; when `enabled` is false the V2 UI never mounts and /code
// renders exactly as today.

import { useEffect, useState } from "react"
import { codexApi } from "./codex-api"

// Only a definitive `enabled:true` is cached (sticky). A `false` or a failed
// probe is NOT cached, so a transient blip or a flag turned on after the first
// probe re-resolves on the next mount/navigation instead of stranding the user
// on the old /code flow forever.
let cached: true | null = null

export function useCodexHealth() {
  const [enabled, setEnabled] = useState<boolean | null>(cached)

  useEffect(() => {
    if (cached === true) { setEnabled(true); return }
    let cancelled = false
    codexApi.health()
      .then((h) => {
        const on = Boolean(h.enabled)
        if (on) cached = true
        if (!cancelled) setEnabled(on)
      })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])

  return { enabled, loading: enabled === null }
}

/** Test/reset hook. */
export function _resetCodexHealthCache() { cached = null }
