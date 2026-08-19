export type PublishingTabId = "overview" | "logs" | "domains" | "manage"

export type PublishingHealthStatus = "healthy" | "degraded" | "unhealthy"

export type PublishingDomain = {
  host: string
  url: string
  registeredWith: string
  verified: boolean
  warning?: boolean
  manageable: boolean
}

export type PublishingTimelineEntry = {
  id: string
  label: string
  publishedAgo: string
  active?: boolean
}

export type PublishingLogEntry = {
  id: string
  time: string
  deployment: string
  source: string
  log: string
  severity: "info" | "warn" | "error"
}

export type PublishingConsoleState = {
  appName: string
  ownerName: string
  statusLabel: string
  visibility: "Public" | "Private"
  seoRating: "HEALTHY" | "NEEDS REVIEW"
  productionUrl: string
  replitUrl: string
  customDomainUrl?: string
  referralLink: string
  geography: string
  deploymentType: string
  deploymentTypeDetail: string
  databaseLabel: string
  healthStatus: PublishingHealthStatus
  lastPublishedAgo: string
  deploymentId: string
  domains: PublishingDomain[]
  timeline: PublishingTimelineEntry[]
  logs: PublishingLogEntry[]
  madeWithReplitBadge: boolean
  apiConfigured: boolean
  generatedAt: string
}

export type PublishingActionId =
  | "republish"
  | "adjust-settings"
  | "security-scan"
  | "buy-domain"
  | "connect-domain"
  | "manage-domain"
  | "pause"
  | "change-deployment-type"
  | "shutdown"
  | "toggle-badge"
  | "install-app"

export type PublishingActionResult = {
  ok: boolean
  message: string
  state?: PublishingConsoleState
}
