"use client"

/**
 * Probe GET /api/agentes-coding/health. Starts disabled so /agentes first
 * paint never grows chrome while the flag is off.
 */

import { useEffect, useState } from "react"

import { agentesCodingApi, shouldMountAgentesCodingIde } from "./api"

export function useAgentesCodingHealth() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    agentesCodingApi
      .health()
      .then((health) => {
        if (!cancelled) setEnabled(shouldMountAgentesCodingIde(health))
      })
      .catch(() => {
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { enabled }
}
