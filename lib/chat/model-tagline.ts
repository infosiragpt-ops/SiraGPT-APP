/**
 * Short Spanish one-liner shown under each model name in the composer picker
 * (Claude-style: "Para tus desafíos más difíciles"). Admin catalog rows carry
 * long marketing descriptions or none at all, so the tagline is derived from
 * the model family and falls back to the first clause of the description.
 */

type TaglineModel = {
  name?: string | null
  displayName?: string | null
  provider?: string | null
  description?: string | null
} | null | undefined

const FAMILY_TAGLINES: ReadonlyArray<[RegExp, string]> = [
  [/typesafe|\bjev\b/, "Decisiones estructuradas y fiables"],
  [/deepseek[-/_\s]?v?4[-/_\s]?pro|sira\s*pro\b/, "Razonamiento para trabajo complejo"],
  [/deepseek[-/_\s]?v?4[-/_\s]?flash|sira\s*r[aá]pido/, "Rápido para las tareas del día a día"],
  [/siragpt\s*mini|sira\s*mini/, "Ligero para respuestas inmediatas"],
  [/\bfable\b/, "Para tus desafíos más difíciles"],
  [/\bopus\b/, "El más capaz para trabajo ambicioso"],
  [/\bsonnet\b/, "Equilibrado para el trabajo diario"],
  [/\bhaiku\b/, "Rápido para respuestas rápidas"],
  [/gemini[^a-z]*[\d.]*\s*(flash|lite)|gemini.*\bflash\b/, "Rápido y multimodal"],
  [/gemini/, "Contexto largo y multimodal"],
  [/grok[^a-z]*[\d.]*\s*(mini|fast)|grok.*\b(mini|fast)\b/, "Ágil para respuestas rápidas"],
  [/grok/, "Ágil y con información actual"],
  [/muse[-\s]?spark|\bmeta\b|llama/, "Agentes, herramientas y contexto"],
  [/kimi|moonshot/, "Contexto largo, código y agentes"],
  [/\bglm\b|z-ai|\bz5/, "Chat, razonamiento y contenido"],
  [/qwen/, "Multilingüe para código y análisis"],
  [/mistral|codestral/, "Eficiente para texto y código"],
  [/gpt[-\s]?[\d.]*\s*(mini|nano)|\b(mini|nano)\b.*gpt/, "Rápido y económico"],
  [/\bgpt|openai|\bo[134]\b/, "Versátil para chat y documentos"],
  [/\b(mini|flash|lite|fast|instant)\b/, "Rápido para respuestas rápidas"],
  [/\b(preview|beta|experimental)\b|\(free\)/, "Vista previa experimental"],
]

function firstClause(description: string): string {
  const clean = description.replace(/\s+/g, " ").trim()
  if (!clean) return ""
  // Drop a leading "<Name> de <Vendor> para" style lead-in so the tagline
  // reads as a purpose, not a repeat of the name above it.
  const purpose = clean.match(/\bpara\s+(.+)$/i)?.[1] || clean
  const clause = purpose.split(/[.;:]/)[0].trim()
  const capped = clause.length > 40 ? `${clause.slice(0, 39).trimEnd()}…` : clause
  return capped ? capped.charAt(0).toUpperCase() + capped.slice(1) : ""
}

export function getModelTagline(model: TaglineModel): string {
  if (!model) return ""
  const hay = `${model.displayName || ""} ${model.name || ""} ${model.provider || ""}`.toLowerCase()
  for (const [pattern, tagline] of FAMILY_TAGLINES) {
    if (pattern.test(hay)) return tagline
  }
  return firstClause(String(model.description || "")) || "Modelo de lenguaje general"
}
