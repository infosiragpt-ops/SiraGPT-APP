"use client"

import { authenticatedFetch } from "./authenticated-fetch"

const API_ROOT = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000/api"

function authHeader(): Record<string, string> {
  const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export type WorkspaceWorkflowStartArgs = {
  goal: string
  model?: string
  maxRuntimeMs?: number
  chatId?: string
  maxSteps?: number
}

export type WorkspaceWorkflowStartResult = {
  ok: boolean
  taskId?: string
  queued?: boolean
  plan?: Record<string, unknown>
  subTasks?: Array<{ goal: string }>
  maxRuntimeMs?: number
  model?: string
  error?: string
}

/**
 * Starts a durable chained workspace workflow (Replit/Cursor-style).
 * The internal orchestrator decomposes the goal into phases and enqueues
 * a long-running agent task (up to 20 h).
 */
export async function startWorkspaceWorkflow(
  args: WorkspaceWorkflowStartArgs,
): Promise<WorkspaceWorkflowStartResult> {
  const resp = await authenticatedFetch(`${API_ROOT}/agent/workspace-workflow`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(args),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err =
      data?.error ||
      data?.errors?.[0]?.msg ||
      `No se pudo iniciar el workflow (HTTP ${resp.status})`
    return { ok: false, error: String(err) }
  }
  return data as WorkspaceWorkflowStartResult
}
