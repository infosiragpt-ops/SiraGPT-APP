/**
 * Spoken completion summary for the /code agent — Claude Code style.
 *
 * When a multi-step task finishes (build / patch / engine / debug), the final
 * assistant turn carries a SHORT spoken digest of what was done, voiced by the
 * browser's local speech synthesis (BrowserVoicePlayer — no API, no cost).
 * Style rules, mirroring how Claude Code reports: lead with the outcome
 * ("Listo." / "Hecho." / "Arreglado."), then the concrete facts (files,
 * errors fixed, duration), then the handoff ("revisa el preview…"). Kept
 * under ~220 chars so the spoken version stays ~10-15 seconds.
 *
 * Pure + deterministic: same input → same string (testable, no Date/random).
 */

export type SpokenSummaryKind = "build" | "patch" | "engine" | "debug"

export type SpokenSummaryInput = {
  kind: SpokenSummaryKind
  /** Number of files written/changed by the task (0/undefined → omitted). */
  filesChanged?: number
  /** Elapsed working time in ms (0/undefined → omitted). */
  durationMs?: number
  /** Errors auto-fixed during the run (debug path). */
  fixedErrors?: number
  /** Short app/goal name to personalize the build summary (already-trusted UI text). */
  appName?: string
  /** Human list of the entities/screens built ("Producto, Venta y Cliente"). */
  entities?: string
  /** What's honestly left to improve (max 2 spoken; derived from real build facts). */
  pending?: string[]
}

const MAX_APP_NAME = 60

function speakDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 1) return ""
  if (s < 60) return `en ${s} segundo${s === 1 ? "" : "s"}`
  const m = Math.round(s / 60)
  return `en ${m} minuto${m === 1 ? "" : "s"}`
}

function speakFiles(n: number): string {
  return `${n} archivo${n === 1 ? "" : "s"}`
}

export function buildSpokenSummary(input: SpokenSummaryInput): string {
  const files = typeof input.filesChanged === "number" && input.filesChanged > 0 ? input.filesChanged : 0
  const dur = typeof input.durationMs === "number" && input.durationMs > 0 ? speakDuration(input.durationMs) : ""
  // Array.from → never split a surrogate pair (emoji) at the clamp boundary.
  const app = Array.from((input.appName || "").trim()).slice(0, MAX_APP_NAME).join("")

  switch (input.kind) {
    case "build":
    case "engine": {
      const what = app ? `tu app «${app}»` : "tu app"
      const parts = [`Listo. Construí ${what}`]
      if (files) parts.push(`con ${speakFiles(files)}`)
      if (dur) parts.push(dur)
      const sentences = [`${parts.join(" ")}.`]
      const entities = (input.entities || "").trim()
      if (entities) sentences.push(`Incluye pantallas para ${entities}.`)
      const pending = (input.pending || []).map((p) => p.trim()).filter(Boolean).slice(0, 2)
      if (pending.length) {
        sentences.push(`Queda pendiente ${pending.join(" y ")}.`)
      }
      sentences.push("El preview ya está corriendo — revísalo y dime qué ajusto.")
      return sentences.join(" ")
    }
    case "patch": {
      const parts = ["Hecho. Apliqué los cambios"]
      if (files) parts.push(`en ${speakFiles(files)}`)
      if (dur) parts.push(dur)
      return `${parts.join(" ")}. Mira el preview y dime si seguimos.`
    }
    case "debug": {
      const fixed = typeof input.fixedErrors === "number" && input.fixedErrors > 0 ? input.fixedErrors : 0
      const head = fixed
        ? `Arreglado. Corregí ${fixed} error${fixed === 1 ? "" : "es"}`
        : "Arreglado. Revisé y corregí el problema"
      const parts = [head]
      if (files) parts.push(`tocando ${speakFiles(files)}`)
      if (dur) parts.push(dur)
      return `${parts.join(" ")}. La app quedó funcionando de nuevo.`
    }
  }
}
