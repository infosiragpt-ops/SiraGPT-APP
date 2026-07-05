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
// The sibling origin that serves codex previews unsandboxed (see /health's
// previewOrigin). Cached alongside the flag; consumers that live outside the
// hook's render cycle (PreviewPane's runApp) read it via the getter.
let cachedPreviewOrigin: string | null = null

/** Last previewOrigin reported by /api/codex/health (https origins only). */
export function getCodexPreviewOrigin(): string | null {
  return cachedPreviewOrigin
}

export function useCodexHealth() {
  const [enabled, setEnabled] = useState<boolean | null>(cached)

  useEffect(() => {
    if (cached === true) { setEnabled(true); return }
    let cancelled = false
    codexApi.health()
      .then((h) => {
        const on = Boolean(h.enabled)
        const origin = typeof h.previewOrigin === "string" ? h.previewOrigin.trim().replace(/\/+$/, "") : ""
        cachedPreviewOrigin = /^https:\/\//.test(origin) ? origin : null
        if (on) cached = true
        if (!cancelled) setEnabled(on)
      })
      .catch(() => { if (!cancelled) setEnabled(false) })
    return () => { cancelled = true }
  }, [])

  return { enabled, loading: enabled === null }
}

/** Test/reset hook. */
export function _resetCodexHealthCache() { cached = null; cachedPreviewOrigin = null }
