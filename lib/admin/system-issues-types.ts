// «Errores del sistema» (Admin → Logs): issues grouped by fingerprint.
// Mirrors backend/src/services/observability/system-errors/store.js.

export type SystemIssueStatus = "nuevo" | "en_revision" | "resuelto" | "ignorado"
export type SystemIssueLevel = "fatal" | "error" | "warning"
export type SystemIssueKind =
  | "excepcion"
  | "promesa"
  | "http"
  | "cola"
  | "redis"
  | "base_de_datos"
  | "proveedor"
  | "sandbox"
  | "frontend"
  | "backend"

export type SystemIssueItem = {
  id: string
  fingerprint: string
  title: string
  culprit: string | null
  kind: SystemIssueKind | string
  kindLabel: string | null
  level: SystemIssueLevel | string
  status: SystemIssueStatus
  statusLabel: string
  regression: boolean
  regressedAt: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  firstSeen: string
  lastSeen: string
  count: number
  lines: number
  usersCount: number
  events24h: number
  /** Events per hour, oldest → newest (24 buckets). */
  sparkline: number[]
  spike: boolean
  lastHour: number
  hourlyAvg: number
  environment: string | null
  lastCommit: string | null
}

export type SystemIssueSample = {
  at: string
  level: string
  source: string
  message: string | null
  stack: string | null
  topFrame: { fn: string | null; file: string; line: number } | null
  route: string | null
  method: string | null
  status: number | null
  reqId: string | null
  userId: string | null
  chatId: string | null
  queue: string | null
  tag: string | null
  page: string | null
  component: string | null
  browser: string | null
  environment: string | null
  commit: string | null
  host: string | null
  burst: number
}

export type SystemIssueLinkedTurn = {
  id: string
  createdAt: string
  category: string | null
  categoryLabel: string | null
  cause: string | null
  prompt: string | null
  userEmail: string | null
  openLink: string | null
}

export type SystemIssueDetail = SystemIssueItem & {
  samples: SystemIssueSample[]
  hours48: number[]
  users: Array<{ id: string; email: string | null; name: string | null }>
  reqIds: string[]
  chatIds: string[]
  commits: string[]
  linkedTurns: SystemIssueLinkedTurn[]
  history: Array<{ at: string; by: string | null; from: string | null; to: string | null }>
  spikeAt: string | null
}

export type AdminSystemIssueList = {
  items: SystemIssueItem[]
  total: number
  page: number
  limit: number
  serverTime: string
}

export type AdminSystemIssueStats = {
  serverTime: string
  open: number
  new24h: number
  regressions: number
  events24h: number
  spikes: number
  resolved7d: number
  byKind: Array<{ kind: string; count: number }>
}

export type AdminSystemIssueAlert = {
  id: string
  issueId: string | null
  createdAt: string
  type: "nuevo" | "regresion"
  title: string
  culprit: string | null
  kind: string
  kindLabel: string | null
  level: string
}

export type AdminSystemIssueRecent = {
  serverTime: string
  count: number
  items: AdminSystemIssueAlert[]
}
