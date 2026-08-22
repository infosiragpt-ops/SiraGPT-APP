// code-chat-plan-label — pull the "planning" line out of an assistant reply so
// the /code chat can show it as a "🧠 …" badge (like the agent dashboard) and
// render the rest as the narrative. The model is prompted to open with a
// gerund-led planning line on its own first line; we only treat the first line
// as a label once it's a complete line (a newline follows) so a still-streaming
// first sentence doesn't get mistaken for a label.

export interface PlanLabelResult {
  /** The planning line (e.g. "Planificando la verificación…"), or null. */
  label: string | null
  /** The reply with the planning line removed when a label was found. */
  body: string
}

// First word is a Spanish gerund (…ando / …iendo / …yendo). Bilingual-friendly:
// also accepts an English "-ing" opener (Planning, Reviewing, Searching).
const PLAN_OPENER = /^(?:[A-ZÁÉÍÓÚ]\p{L}*(?:ando|iendo|yendo)|[A-Z]\p{L}*ing)\b/u

export function extractPlanLabel(content: string): PlanLabelResult {
  const text = content || ""
  const nlIdx = text.indexOf("\n")
  // No complete first line yet → don't commit to a label.
  if (nlIdx === -1) return { label: null, body: text }
  const firstLine = text.slice(0, nlIdx).trim()
  const rest = text.slice(nlIdx + 1).replace(/^\s+/, "")
  const isPlan = firstLine.length > 0 && firstLine.length <= 90 && PLAN_OPENER.test(firstLine)
  if (!isPlan) return { label: null, body: text }
  return { label: firstLine.replace(/[\s:：.]+$/, ""), body: rest }
}


/** OLA200_WAVE_G FE-083 — F4 labels aligned with live-activity (chips stay put). */
const F4_PLAN_LABELS: Record<string, string> = {
  planning: "Planificando", plan_start: "Planificando", orchestrator_start: "Planificando",
  planReady: "Plan listo", plan_ready: "Plan listo", delegating: "Delegando a sub-agente",
  replanning: "Replanificando", str_replace: "Editando el archivo", add_slide: "Agregando una diapositiva",
  document_edit: "Editando el documento", create_docx: "Creando el archivo Word",
}
export function planLabelFromActivity(event?: { type?: string; tool?: string; stage?: string; step?: string } | null): string | null {
  if (!event) return null
  const key = String(event.stage || event.step || event.tool || event.type || "").trim()
  return F4_PLAN_LABELS[key] || null
}
