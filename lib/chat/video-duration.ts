/**
 * Video duration capability helper for /chat.
 * Mirrors official Fal 2026 schemas so the UI never offers seconds a model rejects.
 * Catalog apiData.fal (or a future row's durationMode/min/max/enum) wins over inference.
 */
export type VideoDurationMode = "range" | "enum" | "audio" | "none"

export type VideoDurationSpec = {
  mode: VideoDurationMode
  supportsDuration: boolean
  audioDriven: boolean
  min: number | null
  max: number | null
  step: number | null
  enum: number[] | null
  default: number | null
  format: "seconds" | "seconds-s" | "seconds-int" | null
  maxByResolution?: Record<string, number> | null
}

function range(min: number, max: number, step = 1): number[] {
  const out: number[] = []
  for (let n = min; n <= max; n += step) out.push(n)
  return out
}

function spec(partial: Partial<VideoDurationSpec> & Pick<VideoDurationSpec, "mode">): VideoDurationSpec {
  const supports = partial.mode === "range" || partial.mode === "enum"
  const min = partial.min ?? null
  const max = partial.max ?? null
  const step = partial.step ?? 1
  return {
    mode: partial.mode,
    supportsDuration: partial.supportsDuration ?? supports,
    audioDriven: partial.audioDriven ?? (partial.mode === "audio"),
    min,
    max,
    step: partial.step ?? (supports ? 1 : null),
    enum: partial.enum ?? (supports && min != null && max != null ? range(min, max, step || 1) : null),
    default: partial.default ?? (max != null ? Math.min(8, max) : 8),
    format: partial.format ?? (supports ? "seconds" : null),
    maxByResolution: partial.maxByResolution ?? null,
  }
}

function specFromMetadata(apiData?: Record<string, unknown> | null): VideoDurationSpec | null {
  if (!apiData || typeof apiData !== "object") return null
  const mode = String(apiData.durationMode || apiData.mode || "")
  if (mode !== "audio" && mode !== "none" && mode !== "range" && mode !== "enum") return null
  const enumVals = Array.isArray(apiData.durationEnum)
    ? (apiData.durationEnum as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : null
  return spec({
    mode,
    supportsDuration: apiData.supportsDuration !== false && mode !== "audio" && mode !== "none",
    audioDriven: mode === "audio" || apiData.audioDriven === true,
    min: Number.isFinite(Number(apiData.durationMin)) ? Number(apiData.durationMin) : null,
    max: Number.isFinite(Number(apiData.durationMax)) ? Number(apiData.durationMax) : null,
    step: Number.isFinite(Number(apiData.durationStep)) ? Number(apiData.durationStep) : null,
    enum: enumVals && enumVals.length ? enumVals : null,
    default: Number.isFinite(Number(apiData.durationDefault)) ? Number(apiData.durationDefault) : null,
    format: (apiData.durationFormat as VideoDurationSpec["format"]) || "seconds",
    maxByResolution: (apiData.maxByResolution as Record<string, number>) || null,
  })
}

function inferVideoDurationSpec(modelId?: string | null): VideoDurationSpec {
  const id = String(modelId || "").toLowerCase()
  if (!id) return spec({ mode: "range", min: 4, max: 8, step: 1, default: 8, format: "seconds-s" })
  if (/sync-lipsync|talking-head/.test(id) && !/seedance|kling|veo|sora|wan|pixverse|ltx/.test(id)) {
    return spec({ mode: "audio", supportsDuration: false, audioDriven: true, format: null, default: null })
  }
  if (/cosmos/.test(id)) {
    return spec({ mode: "none", supportsDuration: false, format: null, default: null })
  }
  if (/hailuo/.test(id)) {
    return spec({
      mode: "enum",
      min: 6,
      max: 10,
      enum: [6, 10],
      default: 6,
      format: "seconds",
      maxByResolution: { "1080p": 6 },
    })
  }
  if (/veo/.test(id)) {
    return spec({ mode: "enum", min: 4, max: 8, step: 2, enum: [4, 6, 8], default: 8, format: "seconds-s" })
  }
  if (/seedance-2\.5/.test(id)) {
    return spec({ mode: "range", min: 4, max: 30, step: 1, default: 8, format: "seconds" })
  }
  if (/seedance-2\.0|seedance\/v2/.test(id)) {
    return spec({ mode: "range", min: 4, max: 15, step: 1, default: 8, format: "seconds" })
  }
  if (/seedance\/v1\.5|seedance\/v1\b/.test(id)) {
    return spec({ mode: "range", min: 4, max: 12, step: 1, default: 5, format: "seconds" })
  }
  if (/seedance/.test(id)) {
    return spec({ mode: "range", min: 4, max: 15, step: 1, default: 8, format: "seconds" })
  }
  if (/kling-video\/(v3|o3)/.test(id)) {
    return spec({ mode: "range", min: 3, max: 15, step: 1, default: 5, format: "seconds" })
  }
  if (/kling/.test(id)) {
    return spec({ mode: "enum", min: 5, max: 10, enum: [5, 10], default: 5, format: "seconds" })
  }
  if (/sora/.test(id)) {
    return spec({ mode: "enum", min: 4, max: 20, step: 4, enum: [4, 8, 12, 16, 20], default: 4, format: "seconds-int" })
  }
  if (/pixverse/.test(id)) {
    return spec({ mode: "range", min: 1, max: 15, step: 1, default: 5, format: "seconds-int" })
  }
  if (/wan/.test(id)) {
    return spec({ mode: "range", min: 2, max: 15, step: 1, default: 5, format: "seconds-int" })
  }
  if (/ltx|happy-horse/.test(id)) {
    return spec({ mode: "range", min: 4, max: 8, step: 1, default: 5, format: "seconds" })
  }
  return spec({ mode: "range", min: 4, max: 8, step: 1, default: 8, format: "seconds" })
}

export function resolveVideoDurationSpec(modelId?: string | null, apiData?: Record<string, unknown> | null): VideoDurationSpec {
  return specFromMetadata(apiData) || inferVideoDurationSpec(modelId)
}

function applyResolutionCap(durationSpec: VideoDurationSpec, resolution?: string | null): VideoDurationSpec {
  if (!resolution || !durationSpec.maxByResolution) return durationSpec
  const cap = Number(durationSpec.maxByResolution[String(resolution)])
  if (!Number.isFinite(cap)) return durationSpec
  const next: VideoDurationSpec = {
    ...durationSpec,
    max: Number.isFinite(durationSpec.max as number) ? Math.min(Number(durationSpec.max), cap) : cap,
  }
  if (Array.isArray(next.enum)) next.enum = next.enum.filter((n) => n <= cap)
  return next
}

function snapToEnum(raw: number, enumVals: number[]): number {
  return enumVals.reduce((best, cur) => {
    const dCur = Math.abs(cur - raw)
    const dBest = Math.abs(best - raw)
    if (dCur < dBest) return cur
    if (dCur === dBest && cur > best) return cur
    return best
  })
}

export function clampVideoDuration(
  value: unknown,
  modelOrSpec?: string | null | VideoDurationSpec,
  apiData?: Record<string, unknown> | null,
  resolution?: string | null,
): number | null {
  const specObj = applyResolutionCap(
    modelOrSpec && typeof modelOrSpec === "object"
      ? modelOrSpec
      : resolveVideoDurationSpec(typeof modelOrSpec === "string" ? modelOrSpec : null, apiData),
    resolution,
  )
  if (!specObj.supportsDuration || specObj.audioDriven) return null
  const n = Number.parseInt(String(value ?? ""), 10)
  const fallback = specObj.default ?? specObj.max ?? 8
  const raw = Number.isFinite(n) ? n : fallback
  if (Array.isArray(specObj.enum) && specObj.enum.length) {
    return snapToEnum(raw, specObj.enum)
  }
  const min = Number.isFinite(specObj.min as number) ? Number(specObj.min) : 4
  const max = Number.isFinite(specObj.max as number) ? Number(specObj.max) : Math.max(min, 8)
  const step = Number.isFinite(specObj.step as number) && Number(specObj.step) > 0 ? Number(specObj.step) : 1
  const clamped = Math.min(max, Math.max(min, raw))
  return min + Math.round((clamped - min) / step) * step
}

export function stepVideoDuration(
  value: unknown,
  direction: number,
  modelOrSpec?: string | null | VideoDurationSpec,
  apiData?: Record<string, unknown> | null,
  resolution?: string | null,
): number | null {
  const specObj = applyResolutionCap(
    modelOrSpec && typeof modelOrSpec === "object"
      ? modelOrSpec
      : resolveVideoDurationSpec(typeof modelOrSpec === "string" ? modelOrSpec : null, apiData),
    resolution,
  )
  const current = clampVideoDuration(value, specObj, apiData, resolution)
  if (current == null) return null
  const dir = direction < 0 ? -1 : 1
  if (Array.isArray(specObj.enum) && specObj.enum.length) {
    const ordered = [...specObj.enum].sort((a, b) => a - b)
    const idx = ordered.indexOf(current)
    const nextIdx = Math.min(ordered.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + dir))
    return ordered[nextIdx]
  }
  return clampVideoDuration(current + dir * (specObj.step || 1), specObj, apiData, resolution)
}
