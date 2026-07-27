"use client"

import { authenticatedFetch } from "./authenticated-fetch"

/**
 * Frontend client for /api/hosting — Publishing (deploy a connected repo's
 * build to Hostinger over SFTP/FTP). Mirrors lib/github-service.ts conventions.
 */

const baseUrl = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"}/hosting`

function authHeaders(): HeadersInit {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      message = (await res.json()).error || message
    } catch {
      /* non-json */
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

const get = <T>(p: string) => authenticatedFetch(`${baseUrl}${p}`, { credentials: "include", headers: authHeaders() }).then(handle<T>)
const send = <T>(method: string, p: string, body?: unknown) =>
  authenticatedFetch(`${baseUrl}${p}`, {
    method,
    credentials: "include",
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handle<T>)

export type Protocol = "sftp" | "ftp" | "ftps"

export interface HostingTarget {
  id: string
  provider: string
  label: string
  protocol: Protocol
  host: string
  port: number
  username: string
  remoteBaseDir: string
  siteUrl: string | null
  hasCreds: boolean
  kind?: "password" | "key" | "none"
  createdAt: string
}

export interface TargetInput {
  label: string
  protocol: Protocol
  host: string
  port?: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  remoteBaseDir?: string
  siteUrl?: string | null
}

export interface BuildPlan {
  kind: "node" | "static" | "none"
  framework: string
  buildCommand: string | null
  outputDir: string
}

export interface DeploymentRow {
  id: string
  status: "queued" | "building" | "uploading" | "success" | "error"
  branch: string | null
  buildCommand: string | null
  outputDir: string | null
  remotePath: string | null
  url: string | null
  error: string | null
  logTail: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface DeployConfig {
  targetId: string
  branch?: string
  buildCommand?: string
  outputDir?: string
  remotePath?: string
  cleanSlate?: boolean
  mode?: "static" | "node"
  appName?: string
  remoteCommand?: string
  domain?: string
  domainKind?: "main" | "addon"
  configureNginx?: boolean
  rootDir?: string
  appPort?: string
  ssl?: boolean
  sslEmail?: string
}

export interface DnsInstructions {
  domain: string
  nameservers: string[]
  aRecords: Array<{ type: string; name: string; value: string; ttl: number }>
  steps: string[]
}

export interface VerifyResult {
  reachable: boolean
  status: number
  ms: number
  error?: string
  note?: string
  code?: string
  httpError?: string
}

export const hostingService = {
  listTargets: () => get<{ targets: HostingTarget[] }>("/targets"),
  createTarget: (input: TargetInput) => send<{ ok: boolean; target: HostingTarget }>("POST", "/targets", input),
  updateTarget: (id: string, input: Partial<TargetInput>) =>
    send<{ ok: boolean; target: HostingTarget }>("PUT", `/targets/${id}`, input),
  deleteTarget: (id: string) => send<{ ok: boolean }>("DELETE", `/targets/${id}`),
  testTarget: (id: string) => send<{ ok: boolean }>("POST", `/targets/${id}/test`),

  buildPlan: (connectionId: string) => get<{ plan: BuildPlan }>(`/connected/${connectionId}/build-plan`),
  deploy: (connectionId: string, config: DeployConfig) =>
    send<{ ok: boolean; deploymentId: string }>("POST", `/connected/${connectionId}/deploy`, config),
  listDeployments: (connectionId: string) =>
    get<{ deployments: DeploymentRow[] }>(`/connected/${connectionId}/deployments`),
  deployment: (deploymentId: string) =>
    get<{ deployment: DeploymentRow; live: { status: string; url: string | null; error: string | null; tail: string[] } | null }>(
      `/deployments/${deploymentId}`,
    ),
  cancel: (deploymentId: string) => send<{ ok: boolean; cancelled: boolean }>("POST", `/deployments/${deploymentId}/cancel`),

  // Domain
  verify: (url: string) => send<VerifyResult>("POST", "/verify", { url }),
  dns: (targetId: string, domain: string) => send<{ dns: DnsInstructions }>("POST", "/dns", { targetId, domain }),

  // Build secrets (env)
  getEnv: (connectionId: string) => get<{ keys: string[] }>(`/connected/${connectionId}/env`),
  getEnvValues: (connectionId: string) => get<{ env: Record<string, string> }>(`/connected/${connectionId}/env/values`),
  setEnv: (connectionId: string, env: Record<string, string>) =>
    send<{ ok: boolean; keys: string[] }>("PUT", `/connected/${connectionId}/env`, { env }),

  /** URL for an EventSource-style SSE consumer (auth via query is not used; we poll instead). */
  logsUrl: (deploymentId: string) => `${baseUrl}/deployments/${deploymentId}/logs`,
}
