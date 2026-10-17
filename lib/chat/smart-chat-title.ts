/**
 * Deterministic, <1ms chat title derivation & display normalization.
 *
 * Solves two problems visible in production (/agentes sidebar):
 *   1. Raw `msg.substring(0, 30)` froze typos ("transcirbir", "transcibrir"),
 *      polite filler ("transcribir porfavor"), and mid-word cuts into the
 *      sidebar forever, while ignoring attached file names and URLs.
 *   2. Existing persisted chats with those raw titles need display-time
 *      normalization so the sidebar reads cleanly without mutating DB rows.
 */

const ACTION_VERB_TYPOS: Record<string, string> = {
  transcirbir: "transcribir",
  transcibrir: "transcribir",
  trascribir: "transcribir",
  trancribir: "transcribir",
  transcribri: "transcribir",
  transcribr: "transcribir",
  transcrbir: "transcribir",
  transcripcion: "transcripción",
  resumri: "resumir",
  resmuir: "resumir",
  reusmir: "resumir",
  traducri: "traducir",
  tradcir: "traducir",
  tradusir: "traducir",
  analisrar: "analizar",
  analisar: "analizar",
  anlizar: "analizar",
  explicra: "explicar",
  expicar: "explicar",
  correjir: "corregir",
  coregir: "corregir",
  redcatar: "redactar",
  redactra: "redactar",
   sintetisar: "sintetizar",
  parafraser: "parafrasear",
}

const BARE_ACTION_VERBS = new Set([
  "transcribir",
  "transcribe",
  "transcripción",
  "resumir",
  "resume",
  "resumen",
  "traducir",
  "traduce",
  "analizar",
  "analiza",
  "explicar",
  "explica",
  "corregir",
  "corrige",
  "redactar",
  "redacta",
  "sintetizar",
  "sintetiza",
  "parafrasear",
  "parafrasea",
  "mejorar",
  "mejora",
  "revisar",
  "revisa",
  "extraer",
  "extrae",
  "convertir",
  "convierte",
  "comparar",
  "compara",
  "organizar",
  "organiza",
  "planificar",
  "planifica",
  "construir",
  "construye",
  "generar",
  "genera",
  "crear",
  "crea",
])

const CANONICAL_BARE_VERB_LABELS: Record<string, string> = {
  transcribir: "Transcribir",
  transcribe: "Transcribir",
  "transcripción": "Transcripción",
  resumir: "Resumir",
  resume: "Resumir",
  resumen: "Resumen",
  traducir: "Traducir",
  traduce: "Traducir",
  analizar: "Analizar",
  analiza: "Analizar",
  explicar: "Explicar",
  explica: "Explicar",
  corregir: "Corregir",
  corrige: "Corregir",
  redactar: "Redactar",
  redacta: "Redactar",
  sintetizar: "Sintetizar",
  sintetiza: "Sintetizar",
  parafrasear: "Parafrasear",
  parafrasea: "Parafrasear",
  mejorar: "Mejorar",
  mejora: "Mejorar",
  revisar: "Revisar",
  revisa: "Revisar",
  extraer: "Extraer",
  extrae: "Extraer",
  convertir: "Convertir",
  convierte: "Convertir",
  comparar: "Comparar",
  compara: "Comparar",
  organizar: "Organizar",
  organiza: "Organizar",
  planificar: "Planificar",
  planifica: "Planificar",
  construir: "Construir",
  construye: "Construir",
  generar: "Generar",
  genera: "Generar",
  crear: "Crear",
  crea: "Crear",
}

const GENERIC_PLACEHOLDER_TITLES = new Set([
  "new chat",
  "nuevo chat",
  "nueva conversación",
  "nueva conversacion",
  "untitled",
  "sin título",
  "sin titulo",
])

const POLITE_FILLER_SUFFIX_RE =
  /(?:[,.;:!¡¿?\s]+(?:por\s*favor|porfa(?:vor)?|pf|please|plz|gracias|thanks|urgente))+[!?.…\s]*$/i

const POLITE_FILLER_PREFIX_RE =
  /^(?:(?:hola|buenas(?:\s+tardes|\s+d[ií]as|\s+noches)?|hey|oye)[,.;:!¡¿?\s]+)?(?:(?:por\s*favor|porfa(?:vor)?|please)[,.;:!¡¿?\s]+)?(?:(?:me\s+)?(?:puedes|podr[ií]as|ayudas\s+a|ay[uú]dame\s+a|quiero\s+que\s+me\s+ayudes\s+a|necesito\s+que\s+me\s+ayudes\s+a|quiero|necesito)\s+)?/i

function fixKnownWordTypos(text: string): string {
  return text.replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g, (word) => {
    const lower = word.toLowerCase()
    const replacement = ACTION_VERB_TYPOS[lower]
    if (!replacement) return word
    if (word[0] && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      return replacement.charAt(0).toUpperCase() + replacement.slice(1)
    }
    return replacement
  })
}

function capitalizeNaturalTitle(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  // Do not capitalize slash commands, @mentions, URLs, or code/path tokens
  if (/^[/\\@]/.test(trimmed) || /^https?:\/\//i.test(trimmed)) return trimmed
  const firstToken = trimmed.split(/\s+/)[0] || ""
  if (/[_./:\\]/.test(firstToken)) {
    return trimmed
  }
  const firstChar = trimmed.charAt(0)
  if (firstChar === firstChar.toLowerCase() && firstChar !== firstChar.toUpperCase()) {
    return firstChar.toUpperCase() + trimmed.slice(1)
  }
  return trimmed
}

function truncateAtWordBoundary(text: string, maxChars = 60): string {
  const clean = text.trim()
  if (clean.length <= maxChars) return clean
  const slice = clean.slice(0, maxChars)
  const lastSpace = slice.lastIndexOf(" ")
  const cut = lastSpace > Math.floor(maxChars * 0.5) ? slice.slice(0, lastSpace) : slice
  return `${cut.trimEnd()}…`
}

function extractCompactUrlSubject(rawText: string): string | null {
  const match = rawText.match(/https?:\/\/[^\s<>)"']+/i)
  if (!match?.[0]) return null
  try {
    const parsed = new URL(match[0])
    const host = parsed.hostname.replace(/^www\./i, "")
    if (host === "youtu.be") {
      const id = parsed.pathname.replace(/^\/+/, "").split("/")[0]
      return id ? `youtu.be/${id.slice(0, 14)}` : "YouTube"
    }
    if (host.endsWith("youtube.com")) {
      const v = parsed.searchParams.get("v")
      if (v) return `YouTube · ${v.slice(0, 11)}`
      const parts = parsed.pathname.split("/").filter(Boolean)
      if (parts[0] === "shorts" && parts[1]) return `YouTube Shorts · ${parts[1].slice(0, 11)}`
      return "YouTube"
    }
    const segments = parsed.pathname
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
    const lastSegment = segments[segments.length - 1]
    if (lastSegment && lastSegment.length <= 28 && !/^\d+$/.test(lastSegment)) {
      const decoded = decodeURIComponent(lastSegment).replace(/[-_]+/g, " ")
      return `${host} · ${decoded}`
    }
    return host
  } catch {
    return null
  }
}

function extractFileSubject(files?: unknown[]): string | null {
  if (!Array.isArray(files) || files.length === 0) return null
  for (const item of files) {
    if (!item) continue
    let rawName = ""
    if (typeof item === "string") {
      // Ignore bare UUID/hash file IDs that don't look like human filenames
      if (/^[0-9a-f-]{20,}$/i.test(item.trim()) && !item.includes(".")) continue
      rawName = item
    } else if (typeof item === "object") {
      const rec = item as Record<string, unknown>
      const candidate =
        rec.originalName ??
        rec.name ??
        rec.filename ??
        rec.fileName ??
        rec.title ??
        ""
      if (typeof candidate === "string") rawName = candidate
    }
    const clean = rawName
      .trim()
      .replace(/^.*[\\/]/, "")
      // Strip leading timestamp/UUID prefixes like "1729102000000-audio.mp3"
      .replace(/^\d{10,14}[-_]+/, "")
      .trim()
    if (!clean) continue
    const withoutExt = clean.replace(/\.[a-z0-9]{1,5}$/i, "").trim()
    const base = (withoutExt || clean).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
    if (!base) continue
    const extraCount = files.length > 1 ? ` (+${files.length - 1})` : ""
    return `${truncateAtWordBoundary(base, 32)}${extraCount}`
  }
  return null
}

/**
 * Normalizes a persisted or raw chat title for sidebar display.
 * Safe to run on every render (<0.05ms, pure string operations).
 */
export function normalizeDisplayChatTitle(rawTitle: unknown, fallback = "Nuevo chat"): string {
  const raw = String(rawTitle ?? "")
    .replace(/^🤖\s*Tarea:\s*/i, "")
    .replace(/^🤖\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()

  if (!raw || GENERIC_PLACEHOLDER_TITLES.has(raw.toLowerCase())) {
    return fallback
  }

  const typoFixed = fixKnownWordTypos(raw)
  const strippedFiller = typoFixed.replace(POLITE_FILLER_SUFFIX_RE, "").trim() || typoFixed
  const lowerCandidate = strippedFiller
    .replace(/^[¡¿"«'(\s]+|[!?"»')\s.…:;]+$/g, "")
    .toLowerCase()

  if (CANONICAL_BARE_VERB_LABELS[lowerCandidate]) {
    return CANONICAL_BARE_VERB_LABELS[lowerCandidate]
  }

  // Also check if a conversational prefix + bare verb was used ("por favor transcribir")
  const dePrefixed = strippedFiller.replace(POLITE_FILLER_PREFIX_RE, "").trim()
  const lowerDePrefixed = dePrefixed
    .replace(/^[¡¿"«'(\s]+|[!?"»')\s.…:;]+$/g, "")
    .toLowerCase()
  if (CANONICAL_BARE_VERB_LABELS[lowerDePrefixed] && strippedFiller.split(/\s+/).length <= 5) {
    return CANONICAL_BARE_VERB_LABELS[lowerDePrefixed]
  }

  return capitalizeNaturalTitle(strippedFiller)
}

/**
 * Derives a clean, human-readable chat title from the user's first prompt
 * and optional attached files.
 */
export function deriveSmartChatTitle(
  prompt: unknown,
  files?: unknown[],
  fallback = "Nuevo chat",
): string {
  const raw = String(prompt ?? "").trim()
  const fileSubject = extractFileSubject(files)

  if (!raw) {
    return fileSubject ? truncateAtWordBoundary(fileSubject, 60) : fallback
  }

  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) || raw

  const urlSubject = extractCompactUrlSubject(firstLine) || extractCompactUrlSubject(raw)

  const withoutUrls = firstLine
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#*`>_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!withoutUrls) {
    if (fileSubject) return truncateAtWordBoundary(fileSubject, 60)
    if (urlSubject) return truncateAtWordBoundary(`Enlace · ${urlSubject}`, 60)
    return truncateAtWordBoundary(raw, 50)
  }

  const normalized = normalizeDisplayChatTitle(withoutUrls, fallback)
  const lowerNormalized = normalized.toLowerCase()

  // When the user's text is just a bare action verb ("Transcribir", "Resumir",
  // "Analizar", etc.) and there is a file or URL attached, enrich the title
  // so 10 consecutive transcription chats are distinguishable in the sidebar.
  if (BARE_ACTION_VERBS.has(lowerNormalized)) {
    const canonicalVerb = CANONICAL_BARE_VERB_LABELS[lowerNormalized] || capitalizeNaturalTitle(normalized)
    const contextSubject = fileSubject || urlSubject
    if (contextSubject) {
      return truncateAtWordBoundary(`${canonicalVerb} · ${contextSubject}`, 60)
    }
    return canonicalVerb
  }

  return truncateAtWordBoundary(normalized, 60)
}

/**
 * Returns true when an existing chat title is a generic placeholder or a
 * bare un-enriched action verb that should be upgraded once file/URL context
 * arrives on the first persisted turn.
 */
export function isUpgradeableChatTitle(title: unknown): boolean {
  const raw = String(title ?? "").trim()
  if (!raw) return true
  const lower = raw.toLowerCase()
  if (GENERIC_PLACEHOLDER_TITLES.has(lower)) return true
  const normalized = normalizeDisplayChatTitle(raw, "").toLowerCase()
  return BARE_ACTION_VERBS.has(normalized)
}
