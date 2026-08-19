"use client"

/**
 * useOpencodeEngine — small hook the /code chat uses to know whether the
 * OpenCode engine (vendor/opencode, Bun sidecar behind /api/opencode) is
 * configured/reachable, so it can offer an opt-in "Motor" toggle and degrade
 * to the normal LLM/builder path when the engine is offline.
 *
 * `extractEngineText` pulls readable assistant text out of an OpenCode message
 * result, defensively (the engine returns a message-parts shape).
 */

import * as React from "react"

import { opencodeService } from "./opencode-service"

export function useOpencodeEngine(): { available: boolean; checked: boolean } {
  const [available, setAvailable] = React.useState(false)
  const [checked, setChecked] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    opencodeService
      .health()
      .then((h) => {
        if (alive) setAvailable(!!h.configured)
      })
      .catch(() => {
        if (alive) setAvailable(false)
      })
      .finally(() => {
        if (alive) setChecked(true)
      })
    return () => {
      alive = false
    }
  }, [])

  return { available, checked }
}

/**
 * Extract assistant text from an OpenCode message result. The engine returns a
 * message with `parts` ([{type:'text', text}]); we also tolerate a few other
 * shapes so the UI never shows raw JSON when the contract shifts.
 */
export function extractEngineText(result: unknown): string {
  if (result == null) return ""
  if (typeof result === "string") return result
  const r = result as Record<string, any>

  const parts =
    Array.isArray(r.parts) ? r.parts
    : Array.isArray(r?.message?.parts) ? r.message.parts
    : Array.isArray(r?.info?.parts) ? r.info.parts
    : null

  if (parts) {
    const text = parts
      .filter((p: any) => p && (p.type === "text" || typeof p.text === "string"))
      .map((p: any) => (typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim()
    if (text) return text
  }

  if (typeof r.text === "string") return r.text
  if (typeof r.content === "string") return r.content
  if (typeof r?.message?.text === "string") return r.message.text
  return ""
}
