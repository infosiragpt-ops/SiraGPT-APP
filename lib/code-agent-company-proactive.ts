/**
 * Proactive Agent Company mode — matrix.build-inspired autonomy for /code.
 *
 * When enabled, the company panel treats the workspace as a multi-department
 * agent company: CEO Office owns the objective, departments receive parallel
 * workstreams, and the code agent runs with a proactive company harness.
 */

import {
  AGENT_COMPANY_DEPARTMENTS,
  type AgentDepartmentDefinition,
} from "./code-agent-company"

export const CODE_COMPANY_PROACTIVE_EVENT = "siragpt:code-company-proactive"
export const CODE_FOCUS_CEO_CHAT_EVENT = "siragpt:code-focus-ceo-chat"
export const CODE_COMPANY_SEED_PROMPT_EVENT = "siragpt:code-company-seed-prompt"

const STORAGE_KEY = "code-workspace:agent-company-proactive:v1"

/** Core departments spun up when proactive mode starts (Matrix-style loop). */
export const PROACTIVE_CORE_DEPARTMENTS: readonly AgentDepartmentDefinition[] =
  AGENT_COMPANY_DEPARTMENTS.filter((department) =>
    [
      "ceo-office",
      "product-engineering",
      "agent-infrastructure",
      "growth-engines",
      "marketing",
      "trust",
    ].includes(department.id),
  )

export type ProactiveCompanyState = {
  enabled: boolean
  workspaceId: string | null
  startedAt: number | null
  objective: string | null
}

type ProactiveListener = (state: ProactiveCompanyState) => void

let state: ProactiveCompanyState = {
  enabled: false,
  workspaceId: null,
  startedAt: null,
  objective: null,
}

const listeners = new Set<ProactiveListener>()

function storageKey(workspaceId: string | null | undefined): string {
  return `${STORAGE_KEY}:${workspaceId || "__default__"}`
}

function notify(): void {
  for (const listener of listeners) listener(state)
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CODE_COMPANY_PROACTIVE_EVENT, { detail: { ...state } }),
    )
  }
}

export function getProactiveCompanyState(): ProactiveCompanyState {
  return state
}

export function subscribeProactiveCompany(listener: ProactiveListener): () => void {
  listeners.add(listener)
  listener(state)
  return () => {
    listeners.delete(listener)
  }
}

export function hydrateProactiveCompany(workspaceId: string | null | undefined): ProactiveCompanyState {
  if (typeof window === "undefined") return state
  try {
    const raw = window.localStorage.getItem(storageKey(workspaceId))
    if (!raw) {
      state = { enabled: false, workspaceId: workspaceId || null, startedAt: null, objective: null }
      notify()
      return state
    }
    const parsed = JSON.parse(raw) as Partial<ProactiveCompanyState>
    state = {
      enabled: Boolean(parsed.enabled),
      workspaceId: workspaceId || null,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : null,
      objective: typeof parsed.objective === "string" ? parsed.objective : null,
    }
  } catch {
    state = { enabled: false, workspaceId: workspaceId || null, startedAt: null, objective: null }
  }
  notify()
  return state
}

function persist(): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      storageKey(state.workspaceId),
      JSON.stringify({
        enabled: state.enabled,
        startedAt: state.startedAt,
        objective: state.objective,
      }),
    )
  } catch {
    /* storage disabled */
  }
}

export function setProactiveCompanyEnabled(
  enabled: boolean,
  opts: { workspaceId?: string | null; objective?: string | null } = {},
): ProactiveCompanyState {
  const nextWorkspaceId = opts.workspaceId !== undefined ? opts.workspaceId : state.workspaceId
  const continuingSameRun = enabled && state.enabled && state.workspaceId === nextWorkspaceId
  state = {
    enabled,
    workspaceId: nextWorkspaceId,
    startedAt: enabled ? (continuingSameRun ? state.startedAt ?? Date.now() : Date.now()) : null,
    objective: enabled ? (opts.objective ?? state.objective) : null,
  }
  persist()
  notify()
  return state
}

export function setProactiveCompanyObjective(objective: string | null): ProactiveCompanyState {
  state = { ...state, objective: objective ? String(objective).trim().slice(0, 2000) || null : null }
  persist()
  notify()
  return state
}

export function focusCeoChatColumn(): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(CODE_FOCUS_CEO_CHAT_EVENT))
}

const PENDING_SEED_KEY = "code-workspace:proactive-pending-seed:v1"
const PENDING_SEED_TTL_MS = 2 * 60_000

export function requestProactiveSeedPrompt(prompt: string): void {
  if (typeof window === "undefined") return
  const text = String(prompt || "").trim()
  if (!text) return
  // Reuse the code chat panel's existing agent-request bus so the kickoff
  // flows through the same dispatch / busy-queue as a typed CEO message.
  // The detail object is shared by reference: a mounted listener marks it
  // consumed. If NOBODY consumed it (panel still mounting — the race that
  // made PROACTIVO look dead), stash it so the panel claims it on mount.
  const detail: { text: string; consumed?: boolean } = { text }
  window.dispatchEvent(new CustomEvent("siragpt:code-agent-request", { detail }))
  if (!detail.consumed) {
    try {
      window.sessionStorage.setItem(PENDING_SEED_KEY, JSON.stringify({ text, ts: Date.now() }))
    } catch {
      /* storage disabled: the kickoff is lost, but the toast told the user */
    }
  }
  window.dispatchEvent(
    new CustomEvent(CODE_COMPANY_SEED_PROMPT_EVENT, { detail: { prompt: text } }),
  )
}

/**
 * Claim (read + clear) a kickoff that was requested before the chat panel
 * mounted. TTL-bound so a stale stash can never fire a surprise build on a
 * later visit.
 */
export function claimPendingSeedPrompt(): string | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(PENDING_SEED_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(PENDING_SEED_KEY)
    const parsed = JSON.parse(raw) as { text?: string; ts?: number }
    const text = String(parsed?.text || "").trim()
    const ts = Number(parsed?.ts)
    if (!text || !Number.isFinite(ts) || Date.now() - ts > PENDING_SEED_TTL_MS) return null
    return text
  } catch {
    return null
  }
}

export function buildProactiveKickoffPrompt(companyName: string): string {
  const name = String(companyName || "SiraGPT.COM").trim() || "SiraGPT.COM"
  return [
    `Activa la empresa de agentes ${name} en modo PROACTIVO (estilo matrix.build / 0-person company).`,
    "",
    "Eres el CEO Office. Opera de forma autónoma y continua:",
    "1) Clarifica el objetivo de negocio en UNA pregunta corta SOLO si falta por completo; si ya hay contexto del workspace, asume y ejecuta.",
    "2) Descompón el objetivo en OKRs y tareas por departamento (Producto/Ingeniería, Infraestructura de Agentes, Growth, Marketing, Confianza).",
    "3) Distribuye cada encargo al chat del departamento responsable y conserva el estado y los resultados en CEO Office.",
    "4) Empieza a ejecutar de inmediato: producto, operaciones, contenido o distribución según el objetivo; deja evidencia verificable.",
    "5) Devuelve prueba de avance en cada turno: responsables, entregables, checks, riesgos y siguiente paso autónomo.",
    "6) No esperes micro-aprobaciones para pasos baratos. Escala decisiones irreversibles (borrar datos, gastar dinero, publicar dominio).",
    "7) Para Facebook, LinkedIn o X usa exclusivamente cuentas conectadas y la política guardada en Recursos. Nunca publiques si la pausa global está activa ni excedas el límite diario.",
    "",
    "Primera entrega ahora: propone el plan de empresa + empieza el scaffold del producto en el workspace.",
  ].join("\n")
}

export function buildProactiveCompanySystemBlock(opts: {
  companyName?: string | null
  objective?: string | null
  departments?: readonly AgentDepartmentDefinition[]
} = {}): string {
  const companyName = String(opts.companyName || "SiraGPT.COM").trim() || "SiraGPT.COM"
  const objective = String(opts.objective || "").trim()
  const departments = opts.departments || PROACTIVE_CORE_DEPARTMENTS
  const deptLines = departments
    .map((department) => `- ${department.name}: ${department.description}`)
    .join("\n")

  return [
    "## Modo empresa de agentes PROACTIVO (matrix.build-style)",
    `Empresa: ${companyName}`,
    objective ? `Objetivo activo: ${objective}` : "Objetivo: el usuario lo define en CEO Office; si no hay uno, propón y ejecuta el más valioso con el contexto del workspace.",
    "",
    "Eres el runtime multi-departamento de esta empresa. No eres un chat Q&A pasivo.",
    "Departamentos disponibles:",
    deptLines,
    "",
    "Contrato operativo:",
    "- CEO Office fija prioridad, OKRs y cadencia; los demás departamentos ejecutan en paralelo cuando aplica.",
    "- Cada departamento tiene un chat revisable. Registra allí el encargo, progreso, evidencia y bloqueo; CEO Office conserva el resumen ejecutivo.",
    "- Cada turno debe dejar prueba: código aplicado, preview, checks, o decisión documentada.",
    "- Mantén continuidad entre turnos (memoria de decisiones, blockers, handoffs).",
    "- Prefiere construir y verificar antes que pedir permiso.",
    "- Las publicaciones externas solo se ejecutan mediante la política de Recursos: cuentas OAuth conectadas, pausa global, modo revisión/automático y límite diario.",
    "- En modo Revisión, prepara el contenido pero no lo publiques. En modo Automático, respeta el objetivo y la selección de canales.",
    "- Si el usuario pulsa PROACTIVO, asume autonomía de largo ciclo hasta que diga pausar/detener.",
  ].join("\n")
}

export function departmentBootstrapTitle(department: AgentDepartmentDefinition): string {
  return department.id === "ceo-office" ? "CEO Office" : department.name
}
