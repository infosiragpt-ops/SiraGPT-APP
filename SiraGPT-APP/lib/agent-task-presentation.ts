import type { AgentTaskState } from "./agent-task-service"

export type AgentActivityStatus =
  | "queued"
  | "running"
  | "verifying"
  | "repairing"
  | "completed"
  | "cancelled"
  | "error"
  | "idle"

export interface AgentActivitySummary {
  status: AgentActivityStatus
  label: string
  description: string
  stepCount: number
  toolCount: number
  validationPassed: number
  validationTotal: number
}

export function formatQualityScore(score: number): string {
  const normalized = score > 1 ? score : score * 100
  const bounded = Math.max(0, Math.min(100, normalized))
  return `${Math.round(bounded)}%`
}

const TECHNICAL_TEXT_RE =
  /\b(script|python|bash|shell|node|curl|json|payload|request|response|stdout|stderr|traceback|stack|ejecutando comando|executing command|taskupdate|loading tools|allow cowork file delete|comando)\b/i

const STRUCTURAL_JSON_RE = /[{[\]}]|"[^"]+"\s*:|```/

const TOOL_LABELS: Record<string, string> = {
  web_search: "Buscando fuentes",
  rag_retrieve: "Consultando documentación",
  self_rag_answer: "Sintetizando evidencia",
  create_document: "Generando documento",
  verify_artifact: "Verificando entrega",
  run_tests: "Ejecutando validaciones",
  python_exec: "Procesando datos",
  python: "Procesando datos",
  code_sandbox: "Procesando datos",
  sandbox_exec: "Procesando datos",
  document_pipeline: "Construyendo archivo",
  spreadsheet: "Preparando hoja de cálculo",
  presentation: "Preparando presentación",
  pdf: "Preparando PDF",
}

function lookupToolLabel(value: string): string | null {
  const normalized = value.trim()
  return TOOL_LABELS[normalized] || TOOL_LABELS[normalized.toLowerCase()] || null
}

export function toolToProfessionalLabel(tool?: string | null): string {
  if (!tool) return "Procesando tarea"
  const normalized = String(tool).trim()
  return lookupToolLabel(normalized) || sanitizeAgentText(normalized.replace(/[_-]+/g, " "), "Procesando tarea")
}

export function sanitizeAgentText(value: unknown, fallback = "Procesando tarea"): string {
  const raw = String(value || "").replace(/\s+/g, " ").trim()
  if (!raw) return fallback
  const toolLabel = lookupToolLabel(raw)
  if (toolLabel) return toolLabel
  if (TECHNICAL_TEXT_RE.test(raw) || STRUCTURAL_JSON_RE.test(raw)) return fallback
  if (/^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+$/i.test(raw)) return fallback
  if (raw.length > 92) return `${raw.slice(0, 89).trim()}...`
  return raw
}

export function professionalStepLabel(step: AgentTaskState["steps"][number]): string {
  const firstTool = step.toolCalls?.[0]?.tool
  if (firstTool) return toolToProfessionalLabel(firstTool)

  const raw = String(step.label || "")
  const toolLabel = lookupToolLabel(raw)
  if (toolLabel) return toolLabel
  if (/plan|analiz|analy/i.test(raw)) return "Analizando solicitud"
  if (/search|fuente|source|investig|retrieve|rag/i.test(raw)) return "Buscando fuentes"
  if (/data|dato|proces|calc|sandbox|code/i.test(raw)) return "Procesando datos"
  if (/document|archivo|file|ppt|docx|xlsx|pdf|excel|word/i.test(raw)) return "Generando documento"
  if (/verify|valid|quality|gate|verific|validac/i.test(raw)) return "Verificando entrega"
  if (/repair|regen|corrig|repar/i.test(raw)) return "Corrigiendo entrega"
  if (/final|resumen|ready|listo/i.test(raw)) return "Preparando respuesta final"
  return sanitizeAgentText(raw)
}

export function summarizeAgentActivity(state: AgentTaskState): AgentActivitySummary {
  const tools = new Set<string>()
  for (const step of state.steps || []) {
    for (const call of step.toolCalls || []) {
      if (call.tool) tools.add(call.tool)
    }
  }

  const validationTotal = state.qualityGates?.length || 0
  const validationPassed = (state.qualityGates || []).filter((gate) => gate.passed).length
  const latestRepair = (state.repairs || [])[state.repairs.length - 1]

  let status: AgentActivityStatus = "idle"
  if (state.error === "aborted" || state.queue?.status === "cancelled") {
    status = "cancelled"
  } else if (state.error) {
    status = "error"
  } else if (state.done || state.queue?.status === "completed") {
    status = "completed"
  } else if (latestRepair && latestRepair.status !== "completed") {
    status = "repairing"
  } else if ((state.qualityGates?.length || 0) > 0 && state.steps.some((step) => step.status === "running")) {
    status = "verifying"
  } else if (state.queue?.status === "queued") {
    status = "queued"
  } else if (state.queue?.status === "running" || state.steps.some((step) => step.status === "running")) {
    status = "running"
  }

  const statusText: Record<AgentActivityStatus, { label: string; description: string }> = {
    queued: { label: "En cola", description: "La tarea está esperando turno en el runtime agentico." },
    running: { label: "Ejecutando", description: "El agente está procesando la solicitud por etapas." },
    verifying: { label: "Verificando", description: "Se están validando la respuesta y los documentos generados." },
    repairing: { label: "Reparando", description: "El agente detectó un problema y está regenerando la entrega." },
    completed: { label: "Completado", description: "La entrega fue procesada y validada." },
    cancelled: { label: "Cancelado", description: "La tarea fue detenida antes de finalizar." },
    error: { label: "Error", description: "La tarea no pudo completarse con el runtime actual." },
    idle: { label: "Preparando", description: "La tarea está iniciando." },
  }

  return {
    status,
    label: statusText[status].label,
    description: statusText[status].description,
    stepCount: Math.max(state.steps?.length || 0, state.checkpoints?.length || 0),
    toolCount: tools.size,
    validationPassed,
    validationTotal,
  }
}
