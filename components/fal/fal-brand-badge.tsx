"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

// Per-brand visual identity for the fal.ai model gallery. Each provider gets a
// stable gradient + monogram so the gallery reads like a polished model
// marketplace even for the long tail of providers without a bundled SVG logo.
type BrandStyle = { label: string; from: string; to: string; fg?: string }

const BRAND_STYLES: Record<string, BrandStyle> = {
  flux: { label: "FX", from: "#0ea5e9", to: "#1e293b" },
  openai: { label: "AI", from: "#10a37f", to: "#0b3b32" },
  sora: { label: "So", from: "#111827", to: "#374151" },
  "nano-banana": { label: "NB", from: "#f59e0b", to: "#b45309" },
  veo: { label: "Veo", from: "#4285f4", to: "#1a73e8" },
  google: { label: "G", from: "#4285f4", to: "#ea4335" },
  bytedance: { label: "BD", from: "#0ea5e9", to: "#6366f1" },
  kling: { label: "KL", from: "#7c3aed", to: "#2563eb" },
  minimax: { label: "MM", from: "#ef4444", to: "#7c2d12" },
  luma: { label: "Lu", from: "#06b6d4", to: "#0e7490" },
  ideogram: { label: "Id", from: "#8b5cf6", to: "#db2777" },
  recraft: { label: "Re", from: "#f43f5e", to: "#881337" },
  stability: { label: "SD", from: "#a855f7", to: "#4c1d95" },
  hidream: { label: "HD", from: "#22d3ee", to: "#3b82f6" },
  wan: { label: "Wan", from: "#fb923c", to: "#c2410c" },
  qwen: { label: "Qw", from: "#615ced", to: "#1e1b4b" },
  hunyuan: { label: "Hy", from: "#0ea5e9", to: "#0c4a6e" },
  ltx: { label: "LTX", from: "#84cc16", to: "#3f6212" },
  vidu: { label: "Vi", from: "#14b8a6", to: "#115e59" },
  pika: { label: "Pk", from: "#f472b6", to: "#9d174d" },
  bria: { label: "Br", from: "#64748b", to: "#1e293b" },
  elevenlabs: { label: "11", from: "#111827", to: "#000000" },
  krea: { label: "Kr", from: "#1f2937", to: "#111827" },
  moonvalley: { label: "Mv", from: "#6366f1", to: "#1e1b4b" },
  framepack: { label: "FP", from: "#0ea5e9", to: "#155e75" },
  mochi: { label: "Mo", from: "#f97316", to: "#9a3412" },
  cogvideo: { label: "Cg", from: "#3b82f6", to: "#1e3a8a" },
  trellis: { label: "Tr", from: "#0078d4", to: "#004578" },
  rodin: { label: "Ro", from: "#475569", to: "#0f172a" },
  meshy: { label: "Me", from: "#22c55e", to: "#14532d" },
  tripo: { label: "Tp", from: "#06b6d4", to: "#164e63" },
  kokoro: { label: "Ko", from: "#fb7185", to: "#9f1239" },
  cassette: { label: "Ca", from: "#eab308", to: "#854d0e" },
  playht: { label: "PH", from: "#8b5cf6", to: "#5b21b6" },
  dia: { label: "Dia", from: "#14b8a6", to: "#0f766e" },
  chatterbox: { label: "Cb", from: "#f59e0b", to: "#b45309" },
  riffusion: { label: "Rf", from: "#ec4899", to: "#831843" },
  sonauto: { label: "Sn", from: "#a3e635", to: "#4d7c0f" },
  imagineart: { label: "IA", from: "#d946ef", to: "#701a75" },
  veed: { label: "Vd", from: "#ec4f5b", to: "#7f1d1d" },
  grok: { label: "xAI", from: "#1f2937", to: "#000000" },
  fal: { label: "fal", from: "#6366f1", to: "#0ea5e9" },
}

const DEFAULT_STYLE: BrandStyle = BRAND_STYLES.fal

export function FalBrandBadge({
  iconKey,
  size = 44,
  className,
}: {
  iconKey: string
  size?: number
  className?: string
}) {
  const style = BRAND_STYLES[iconKey] || DEFAULT_STYLE
  const fontSize = Math.round(size * (style.label.length > 2 ? 0.3 : 0.4))
  return (
    <span
      className={cn(
        "fal-brand-badge relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-2xl font-bold tracking-tight",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize,
        color: style.fg || "#fff",
        backgroundImage: `linear-gradient(135deg, ${style.from} 0%, ${style.to} 100%)`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -8px 16px rgba(0,0,0,0.25)",
      }}
      aria-hidden="true"
    >
      {/* glossy liquid highlight */}
      <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 rounded-t-2xl bg-gradient-to-b from-white/45 to-transparent" />
      <span className="relative drop-shadow-sm">{style.label}</span>
    </span>
  )
}

export default FalBrandBadge
