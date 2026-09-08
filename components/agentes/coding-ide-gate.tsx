"use client"

/**
 * Mounts the /agentes coding IDE only when GET /health reports enabled.
 * Flag off ⇒ render nothing (same first paint as today's /agentes).
 */

import dynamic from "next/dynamic"

import { useAgentesCodingHealth } from "@/lib/agentes-coding/health"

const CodingIdeShell = dynamic(
  () => import("./coding-ide-shell").then((mod) => mod.CodingIdeShell),
  { ssr: false },
)

export function AgentesCodingIdeGate() {
  const { enabled } = useAgentesCodingHealth()
  if (!enabled) return null
  return <CodingIdeShell />
}

export default AgentesCodingIdeGate
