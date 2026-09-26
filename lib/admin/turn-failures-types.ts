/**
 * Shapes of the turn failure tracker API (Admin → Logs → «Fallos de
 * respuesta»). Mirrors backend/src/services/observability/turn-failures.
 */

export type TurnFailureCategory =
  | "sin_respuesta"
  | "colgado"
  | "sin_cierre"
  | "adjunto_perdido"
  | "error_visible"
  | "herramienta_fallida"
  | "cancelado_por_sistema"
  | "respuesta_no_entendible"
  | "usuario_reporto"

export type TurnFailureSeverity = "critical" | "high" | "medium" | "low"
export type TurnFailureSound = "strong" | "soft"

export type TurnFailureStage = { label: string; tool?: string; atMs: number }
export type TurnFailureNote = { kind: string; atMs: number; data?: Record<string, unknown> }
export type TurnFailureSignal = { source: string; category: string; cause: string; at: string }

export type TurnFailureMetadata = {
  category?: TurnFailureCategory
  categoryLabel?: string
  severity?: TurnFailureSeverity
  sound?: TurnFailureSound
  cause?: string
  fingerprint?: string
  reasons?: string[]
  route?: string | null
  chatId?: string | null
  openLink?: string | null
  prompt?: string | null
  modelPicked?: string | null
  modelLabel?: string | null
  modelUsed?: string | null
  providerUsed?: string | null
  fallbackChain?: string[] | null
  attachments?: Array<{ name?: string | null; type?: string | null; kind?: string | null; textChars?: number }>
  startedAt?: string
  ttfbMs?: number | null
  firstVisibleMs?: number | null
  totalMs?: number | null
  endReason?: string | null
  status?: number | null
  whatUserSaw?: string | null
  errorCode?: string | number | null
  errorMessage?: string | null
  artifactsCount?: number
  stages?: TurnFailureStage[]
  notes?: TurnFailureNote[]
  reqIds?: string[]
  commit?: string | null
  browser?: string | null
  signals?: TurnFailureSignal[]
  occurrences?: number
  [key: string]: unknown
}

export type AdminTurnFailureItem = {
  id: string
  createdAt: string
  userId: string | null
  userEmail: string | null
  resourceId: string | null
  category: TurnFailureCategory | null
  categoryLabel: string | null
  severity: TurnFailureSeverity | null
  sound: TurnFailureSound
  cause: string | null
  fingerprint: string | null
  model: string | null
  route: string | null
  prompt: string | null
  whatUserSaw: string | null
  totalMs: number | null
  ttfbMs: number | null
  chatId: string | null
  occurrences: number
  metadata: TurnFailureMetadata
}

export type AdminTurnFailureList = {
  items: AdminTurnFailureItem[]
  total: number | null
  page: number
  limit: number
}

export type TurnFailureCause = {
  fingerprint: string
  cause: string | null
  category: TurnFailureCategory | null
  categoryLabel: string | null
  severity: TurnFailureSeverity | null
  count: number
  previousCount: number
  trendPct: number | null
  isNew: boolean
  affectedUsers: number
  topModels: Array<{ model: string; count: number }>
  lastAt: string
  examples: Array<{ id: string; createdAt: string; userEmail: string | null; prompt: string | null }>
}

export type AdminTurnFailureStats = {
  serverTime: string
  counts: { lastHour: number; last24h: number; last7d: number }
  byCategory24h: Array<{ name: string; count: number; label: string }>
  byModel24h: Array<{ name: string; count: number }>
  failureRate24h: { failed: number; total: number | null; pct: number | null }
  topCauses: { "24h": TurnFailureCause[]; "7d": TurnFailureCause[] }
}

export type AdminTurnFailureRecentItem = {
  id: string
  createdAt: string
  category: TurnFailureCategory | null
  categoryLabel: string | null
  severity: TurnFailureSeverity | null
  sound: TurnFailureSound
  cause: string | null
  userEmail: string | null
  model: string | null
}

export type AdminTurnFailureRecent = {
  serverTime: string
  count: number
  items: AdminTurnFailureRecentItem[]
}
