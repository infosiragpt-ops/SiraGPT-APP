import type { AgentPhase } from "./code-agent/types"
import type { CodeChatSession } from "./code-chat-sessions"

export type AgentDepartmentDefinition = {
  id: string
  name: string
  description: string
  keywords: readonly string[]
}

export type AgentCompanySessionStatus = {
  label: string
  tone: "idle" | "active" | "ready" | "attention"
}

export type AgentCompanySnapshot = {
  rootSessionId: string | null
  activeAgents: number
  taskCount: number
  fileCount: number
  resourceCount: number
  latestActivityAt: number | null
}

type WorkspaceFileLike = { content?: string } | undefined

export type AgentCompanyRunLike = {
  id: string
  status: string
  prompt?: string | null
  error?: string | null
  createdAt?: string | Date | null
  startedAt?: string | Date | null
  finishedAt?: string | Date | null
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_approval"])

export const AGENT_COMPANY_DEPARTMENTS: readonly AgentDepartmentDefinition[] = [
  {
    id: "ceo-office",
    name: "CEO Office",
    description: "Define prioridades, conserva decisiones y coordina el trabajo.",
    keywords: ["ceo", "dirección", "direccion", "estrategia", "roadmap"],
  },
  {
    id: "agent-infrastructure",
    name: "Infraestructura de Agentes",
    description: "Orquestación, runners, aislamiento y continuidad operativa.",
    keywords: ["agente", "agent", "runner", "sandbox", "infraestructura", "orquestación", "orquestacion"],
  },
  {
    id: "growth-engines",
    name: "Motores de Crecimiento y Distribución",
    description: "Adquisición, distribución, monetización y crecimiento medible.",
    keywords: ["growth", "crecimiento", "distribución", "distribucion", "ventas", "monetización", "monetizacion"],
  },
  {
    id: "localization",
    name: "Localización e IA Transcultural",
    description: "Idiomas, regiones, accesibilidad cultural y adaptación de mercado.",
    keywords: ["localización", "localizacion", "idioma", "traducción", "traduccion", "mercado"],
  },
  {
    id: "integrations",
    name: "Ecosistema de Integraciones y Conectores",
    description: "APIs, canales, conectores, herramientas y automatizaciones.",
    keywords: ["integración", "integracion", "api", "conector", "mcp", "oauth", "webhook"],
  },
  {
    id: "trust",
    name: "Confianza, Privacidad y Cumplimiento",
    description: "Seguridad, permisos, privacidad, auditoría y cumplimiento.",
    keywords: ["seguridad", "security", "privacidad", "privacy", "cumplimiento", "compliance", "permiso"],
  },
  {
    id: "product-engineering",
    name: "Producto e Ingeniería SiraGPT",
    description: "Arquitectura, experiencia de producto y entrega verificable.",
    keywords: ["producto", "frontend", "backend", "diseño", "diseno", "código", "codigo", "build", "preview"],
  },
  {
    id: "engineering-01",
    name: "INGENIEROS 01",
    description: "Implementación principal y evolución del producto.",
    keywords: ["ingenieros 01", "ingeniería 01", "ingenieria 01", "equipo 1"],
  },
  {
    id: "marketing",
    name: "Marketing",
    description: "Posicionamiento, contenido, campañas y señales de mercado.",
    keywords: ["marketing", "campaña", "campana", "contenido", "seo", "social"],
  },
  {
    id: "engineering-02",
    name: "INGENIEROS 02",
    description: "Validación técnica, QA, depuración e integración final.",
    keywords: ["ingenieros 02", "ingeniería 02", "ingenieria 02", "qa", "test", "debug", "equipo 2"],
  },
] as const

const ACTIVE_PHASES: ReadonlySet<AgentPhase> = new Set(["intake", "generating", "debugging"])

export function agentCompanyDisplayName(rawName?: string | null): string {
  const raw = String(rawName || "").trim()
  if (!raw || /^(nueva app|new app|nuevo proyecto|untitled|workspace)(\b|\s)/i.test(raw)) {
    return "SiraGPT.COM"
  }
  if (/sira\s*gpt/i.test(raw)) return "SiraGPT.COM"
  if (/tesis\s*20/i.test(raw)) return "TESIS20.COM"
  if (/\.[a-z]{2,}$/i.test(raw)) return raw.toUpperCase()

  const clean = raw.replace(/\s+/g, " ").trim()
  if (/^[a-z0-9_-]{2,24}$/i.test(clean)) return `${clean.toUpperCase()}.COM`
  return clean
}

export function codeSessionIsActive(session: CodeChatSession): boolean {
  if (session.turns.some((turn) => turn.streaming)) return true
  return ACTIVE_PHASES.has(session.agent?.phase ?? "idle")
}

function codeSessionHasWork(session: CodeChatSession): boolean {
  return codeSessionIsActive(session) || session.turns.some((turn) => turn.content.trim().length > 0)
}

export function codeSessionStatus(session: CodeChatSession): AgentCompanySessionStatus {
  if (session.turns.some((turn) => turn.streaming)) {
    return { label: "Trabajando", tone: "active" }
  }
  switch (session.agent?.phase ?? "idle") {
    case "intake":
      return { label: "Recopilando contexto", tone: "active" }
    case "generating":
      return { label: "Construyendo", tone: "active" }
    case "preview":
      return { label: "Listo para verificar", tone: "ready" }
    case "debugging":
      return { label: "Corrigiendo", tone: "attention" }
    default:
      return { label: session.turns.length > 0 ? "En espera" : "Disponible", tone: "idle" }
  }
}

export function codeRunIsActive(run: AgentCompanyRunLike): boolean {
  return ACTIVE_RUN_STATUSES.has(String(run.status || "").toLowerCase())
}

export function codeRunStatus(run: AgentCompanyRunLike): AgentCompanySessionStatus {
  switch (String(run.status || "").toLowerCase()) {
    case "queued":
      return { label: "En cola", tone: "active" }
    case "running":
      return { label: "Ejecutando", tone: "active" }
    case "waiting_approval":
      return { label: "Listo para revisar", tone: "attention" }
    case "done":
      return { label: "Evidencia lista", tone: "ready" }
    case "error":
      return { label: "Requiere atención", tone: "attention" }
    case "cancelled":
      return { label: "Cancelado", tone: "idle" }
    default:
      return { label: "Disponible", tone: "idle" }
  }
}

function normalizedMatchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/\s+/g, " ")
    .trim()
}

export function departmentIdForRun(
  run: AgentCompanyRunLike,
  departments: readonly AgentDepartmentDefinition[] = AGENT_COMPANY_DEPARTMENTS,
): string {
  const prompt = String(run.prompt || "")
  const proactiveDepartment = /^\s*\[PROACTIVO\s*·\s*([^\]]+)\]/i.exec(prompt)?.[1]
  if (proactiveDepartment) {
    const normalizedDepartment = normalizedMatchText(proactiveDepartment)
    const exact = departments.find((department) => normalizedMatchText(department.name) === normalizedDepartment)
    if (exact) return exact.id
  }

  const haystack = normalizedMatchText(`${prompt} ${run.error || ""}`)
  let bestMatch: { id: string; score: number } | null = null
  for (const department of departments) {
    if (department.id === "ceo-office" || department.id === "product-engineering") continue
    const score = department.keywords.reduce(
      (total, keyword) => total + (haystack.includes(normalizedMatchText(keyword)) ? 1 : 0),
      0,
    )
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { id: department.id, score }
    }
  }
  return bestMatch?.id ?? "product-engineering"
}

export function codeRunActivityAt(run: AgentCompanyRunLike): number {
  const candidates = [run.finishedAt, run.startedAt, run.createdAt]
  for (const candidate of candidates) {
    if (!candidate) continue
    const value = candidate instanceof Date ? candidate.getTime() : Date.parse(candidate)
    if (Number.isFinite(value)) return value
  }
  return 0
}

export function countWorkspaceResources(files: Record<string, WorkspaceFileLike>): number {
  const packagePath = Object.keys(files).find((path) => /(^|\/)package\.json$/i.test(path))
  const raw = packagePath ? files[packagePath]?.content : null
  if (!raw) return 0
  try {
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      peerDependencies?: Record<string, unknown>
    }
    return new Set([
      ...Object.keys(parsed.dependencies || {}),
      ...Object.keys(parsed.devDependencies || {}),
      ...Object.keys(parsed.peerDependencies || {}),
    ]).size
  } catch {
    return 0
  }
}

export function rootCodeSessionId(sessions: readonly CodeChatSession[]): string | null {
  if (sessions.length === 0) return null
  const ceoOffice = sessions.find((session) => session.title.trim().toLowerCase() === "ceo office")
  if (ceoOffice) return ceoOffice.id
  return [...sessions].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? null
}

function sessionSearchText(session: CodeChatSession): string {
  const recent = session.turns.slice(-4).map((turn) => turn.content).join(" ")
  return `${session.title} ${recent}`.toLocaleLowerCase("es")
}

export function departmentIdForSession(
  session: CodeChatSession,
  rootSessionId: string | null,
  departments: readonly AgentDepartmentDefinition[] = AGENT_COMPANY_DEPARTMENTS,
): string {
  if (session.id === rootSessionId) return "ceo-office"
  const haystack = sessionSearchText(session)
  let bestMatch: { id: string; score: number } | null = null
  for (const department of departments) {
    if (department.id === "ceo-office" || department.id === "product-engineering") continue
    const score = department.keywords.reduce(
      (total, keyword) => total + (haystack.includes(keyword.toLocaleLowerCase("es")) ? 1 : 0),
      0,
    )
    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { id: department.id, score }
    }
  }
  return bestMatch?.id ?? "product-engineering"
}

export function buildAgentCompanySnapshot(
  sessions: readonly CodeChatSession[],
  files: Record<string, WorkspaceFileLike>,
  runs: readonly AgentCompanyRunLike[] = [],
): AgentCompanySnapshot {
  const sessionActiveAgents = sessions.filter(codeSessionIsActive).length
  const sessionTaskCount = sessions.filter(codeSessionHasWork).length
  const runLatestActivityAt = runs.length > 0
    ? Math.max(...runs.map(codeRunActivityAt))
    : null
  const sessionLatestActivityAt = sessions.length > 0
    ? Math.max(...sessions.map((session) => session.updatedAt))
    : null
  const latestActivityAt = [runLatestActivityAt, sessionLatestActivityAt]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)

  return {
    rootSessionId: rootCodeSessionId(sessions),
    activeAgents: runs.length > 0 ? runs.filter(codeRunIsActive).length : sessionActiveAgents,
    taskCount: runs.length > 0 ? runs.length : sessionTaskCount,
    fileCount: Object.keys(files).length,
    resourceCount: countWorkspaceResources(files),
    latestActivityAt: latestActivityAt.length > 0 ? Math.max(...latestActivityAt) : null,
  }
}
