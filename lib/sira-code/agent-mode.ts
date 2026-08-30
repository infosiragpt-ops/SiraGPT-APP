/**
 * SiraCode agent mode for /agentes.
 *
 * Stable ids match the native engine. Spanish product labels only.
 */

export const SIRA_CODE_AGENTS = [
  { id: "construir", label: "Construir", role: "build" },
  { id: "planificar", label: "Planificar", role: "plan" },
] as const

export type SiraCodeAgentId = (typeof SIRA_CODE_AGENTS)[number]["id"]

export const DEFAULT_SIRA_CODE_AGENT: SiraCodeAgentId = "construir"
export const SIRA_CODE_AGENT_STORAGE_KEY = "siragpt:sira-code-agent"

const IDS = new Set<string>(SIRA_CODE_AGENTS.map((a) => a.id))

export function isSiraCodeAgentId(value: unknown): value is SiraCodeAgentId {
  return typeof value === "string" && IDS.has(value)
}

export function resolveSiraCodeAgentId(value: unknown): SiraCodeAgentId {
  return isSiraCodeAgentId(value) ? value : DEFAULT_SIRA_CODE_AGENT
}

export function siraCodeAgentLabel(id: unknown): string {
  const resolved = resolveSiraCodeAgentId(id)
  const row = SIRA_CODE_AGENTS.find((a) => a.id === resolved)
  return row ? row.label : "Construir"
}
