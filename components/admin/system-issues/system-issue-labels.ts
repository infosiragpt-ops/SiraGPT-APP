import type { SystemIssueStatus } from "@/lib/admin/system-issues-types"

export const ISSUE_STATUS_LABELS: Record<SystemIssueStatus, string> = {
  nuevo: "Nuevo",
  en_revision: "En revisión",
  resuelto: "Resuelto",
  ignorado: "Ignorado",
}

export const ISSUE_KIND_LABELS: Record<string, string> = {
  excepcion: "Excepción no controlada",
  promesa: "Promesa rechazada",
  http: "HTTP 5xx",
  cola: "Cola / worker",
  redis: "Redis",
  base_de_datos: "Base de datos",
  proveedor: "Proveedor IA",
  sandbox: "Sandbox",
  frontend: "Frontend",
  backend: "Backend",
}

export const ISSUE_KIND_ORDER = ["excepcion", "promesa", "http", "cola", "redis", "base_de_datos", "proveedor", "sandbox", "frontend", "backend"]

export const ISSUE_STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "abiertos", label: "Abiertos" },
  { value: "nuevo", label: "Nuevos" },
  { value: "regresiones", label: "Regresiones" },
  { value: "en_revision", label: "En revisión" },
  { value: "resuelto", label: "Resueltos" },
  { value: "ignorado", label: "Ignorados" },
  { value: "todos", label: "Todos" },
]

export function kindLabel(kind?: string | null, fallback?: string | null): string {
  if (kind && ISSUE_KIND_LABELS[kind]) return ISSUE_KIND_LABELS[kind]
  return fallback || kind || "Backend"
}

export function issueStatusLabel(status?: string | null): string {
  if (status && status in ISSUE_STATUS_LABELS) return ISSUE_STATUS_LABELS[status as SystemIssueStatus]
  return status || "Nuevo"
}

export function issueStatusClass(status?: string | null): string {
  switch (status) {
    case "nuevo": return "border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-500/10 dark:text-red-200"
    case "en_revision": return "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200"
    case "resuelto": return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200"
    default: return "border-border bg-muted/40 text-muted-foreground"
  }
}

export function levelClass(level?: string | null): string {
  switch (level) {
    case "fatal": return "bg-red-600 text-white"
    case "error": return "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200"
    default: return "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"
  }
}

export function levelLabel(level?: string | null): string {
  if (level === "fatal") return "Fatal"
  if (level === "warning") return "Aviso"
  return "Error"
}

export function formatCount(n?: number | null): string {
  const v = Number(n) || 0
  if (v >= 10000) return `${Math.round(v / 1000)} mil`
  return new Intl.NumberFormat("es").format(v)
}
