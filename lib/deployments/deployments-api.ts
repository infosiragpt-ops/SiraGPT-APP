// deployments/deployments-api — typed HTTP client for the Deployments module
// (/api/deployments/*). Mirrors lib/codex/codex-api.ts: localStorage JWT Bearer
// + credentials:include. Management clone of Replit's Deployments tab.

const BASE = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api").replace(/\/+$/, "")}/deployments`

function authHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: "include", headers: authHeaders(), ...init })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error((body as any)?.message || (body as any)?.error || `deployments http ${res.status}`), { status: res.status, body })
  return body as T
}

export type DeploymentType = "autoscale" | "reserved_vm" | "static" | "scheduled" | "hostinger_vps" | "aws"
export type DeploymentStatus = "building" | "running" | "failed" | "paused" | "suspended" | "shut_down"
export type DeploymentVisibility = "public" | "workspace" | "private" | "password"
export type DeploymentGeography = "na" | "eu" | "sa" | "asia" | "au"

export interface Deployment {
  id: string
  name: string
  projectId: string | null
  deploymentType: DeploymentType
  typeLabel: string
  status: DeploymentStatus
  suspendedReason: string | null
  visibility: DeploymentVisibility
  geography: DeploymentGeography
  geographyLabel: string
  machineTier: string
  machineLabel: string
  monthlyUsd: number | null
  cpu: number | null
  memoryMb: number | null
  subdomain: string
  defaultDomain: string
  buildCommand: string | null
  runCommand: string | null
  publicDir: string | null
  externalPort: number | null
  databaseConnected: boolean
  databaseProvider: string | null
  currentVersionId: string | null
  createdAt: string
  updatedAt: string
}

export interface DeploymentVersion {
  id: string
  deploymentId: string
  shortHash: string
  status: "provisioning" | "security_scan" | "building" | "bundling" | "promoted" | "failed" | "rolled_back"
  isLive: boolean
  isRollback: boolean
  rolledBackFromId: string | null
  publishedById: string | null
  securityScan: SecurityScan | null
  createdAt: string
}

export interface DnsRecord { type: "A" | "TXT" | "MX"; name: string; value: string; ttl: number }

export interface DeploymentDomain {
  id: string
  deploymentId: string
  hostname: string
  kind: "default" | "custom" | "purchased"
  isPrimary: boolean
  verificationStatus: "pending" | "verified" | "failed"
  tlsStatus: "provisioning" | "active"
  dnsRecords: DnsRecord[] | null
  createdAt: string
}

export interface SecurityFinding { severity: "critical" | "high" | "medium" | "low"; category: string; title: string }
export interface SecurityScan { status: "passed" | "failed"; scannedAt: string | null; findings: SecurityFinding[]; summary: string }

export interface LogEntry { ts: string; source: "User" | "System"; level: "info" | "error"; message: string; deployment: string | null; index?: number }
export interface PublishPhase { name: string; status: "done" | "failed"; logs: string[] }
export interface DeploymentDetail { deployment: Deployment; versions: DeploymentVersion[]; domains: DeploymentDomain[] }
export interface DeploymentsHealth { ok: boolean; enabled: boolean }

export type DeploymentProviderId = "hostinger_vps" | "aws" | "godaddy_dns"

export interface DeploymentProviderEnvRow {
  key: string
  configured: boolean
}

export interface DeploymentProvider {
  id: DeploymentProviderId
  label: string
  category: "compute" | "domain"
  mode: string
  description: string
  configured: boolean
  missingRequired: string[]
  requiredEnv: DeploymentProviderEnvRow[]
  optionalEnv: DeploymentProviderEnvRow[]
  capabilities: string[]
  docsUrl: string
}

export interface DeploymentProviderPlan {
  provider: DeploymentProvider
  ready: boolean
  target: Record<string, unknown> | null
  steps: string[]
  dnsRecords?: DnsRecord[]
}

export interface ProviderConnectResult {
  deployment: Deployment
  provider: DeploymentProvider
  plan: DeploymentProviderPlan
}

export interface DomainProviderResult {
  applied: boolean
  providerId: DeploymentProviderId
  reason: string | null
  missingRequired?: string[]
  rootDomain?: string
  recordName?: string
  attemptedRecords?: Array<Record<string, unknown>>
  status?: number
  message?: string
}

export interface CreateDeploymentInput {
  name: string
  deploymentType?: DeploymentType
  visibility?: DeploymentVisibility
  geography?: DeploymentGeography
  machineTier?: string
  projectId?: string | null
}

export type DeploymentPatch = Partial<Pick<Deployment, "buildCommand" | "runCommand" | "publicDir" | "visibility" | "deploymentType" | "machineTier" | "externalPort">>

export const deploymentsApi = {
  // no-store: the flag can flip; a cached enabled:false would strand the UI.
  health: () => req<DeploymentsHealth>("/health", { cache: "no-store" }),

  list: () => req<{ deployments: Deployment[] }>("/").then((r) => r.deployments),
  providers: () => req<{ providers: DeploymentProvider[] }>("/providers", { cache: "no-store" }).then((r) => r.providers),
  create: (input: CreateDeploymentInput) => req<{ deployment: Deployment }>("/", { method: "POST", body: JSON.stringify(input) }).then((r) => r.deployment),
  get: (id: string) => req<DeploymentDetail>(`/${id}`),
  update: (id: string, patch: DeploymentPatch) => req<{ deployment: Deployment }>(`/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then((r) => r.deployment),

  publish: (id: string, hasFiles = true) => req<{ deployment: Deployment; version: DeploymentVersion; phases: PublishPhase[] }>(`/${id}/publish`, { method: "POST", body: JSON.stringify({ hasFiles }) }),
  rollback: (id: string, versionId: string) => req<{ deployment: Deployment; version: DeploymentVersion }>(`/${id}/rollback`, { method: "POST", body: JSON.stringify({ versionId }) }),

  pause: (id: string) => req<{ deployment: Deployment }>(`/${id}/pause`, { method: "POST" }).then((r) => r.deployment),
  resume: (id: string) => req<{ deployment: Deployment }>(`/${id}/resume`, { method: "POST" }).then((r) => r.deployment),
  shutdown: (id: string) => req<{ deployment: Deployment }>(`/${id}/shutdown`, { method: "POST" }).then((r) => r.deployment),

  securityScan: (id: string) => req<{ scan: SecurityScan }>(`/${id}/security-scan`, { method: "POST" }).then((r) => r.scan),

  connectProvider: (id: string, provider: Extract<DeploymentProviderId, "hostinger_vps" | "aws">) =>
    req<ProviderConnectResult>(`/${id}/providers/connect`, { method: "POST", body: JSON.stringify({ provider }) }),

  addDomain: (id: string, hostname: string) => req<{ domain: DeploymentDomain }>(`/${id}/domains`, { method: "POST", body: JSON.stringify({ hostname }) }).then((r) => r.domain),
  addGoDaddyDomain: (id: string, hostname: string) =>
    req<{ domain: DeploymentDomain; providerResult: DomainProviderResult }>(`/${id}/domains/godaddy`, { method: "POST", body: JSON.stringify({ hostname }) }),
  removeDomain: (id: string, domainId: string) => req<{ ok: boolean }>(`/${id}/domains/${domainId}`, { method: "DELETE" }),

  logs: (id: string) => req<{ lines: string[]; entries: LogEntry[]; versionHash: string | null }>(`/${id}/logs`),

  // SSE log tail. Returns an EventSource-like URL with the JWT in the query
  // (EventSource can't set headers; the route accepts ?token= as a fallback).
  logsStreamUrl: (id: string) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
    return `${BASE}/${id}/logs/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`
  },
}
