// Enterprise command-center and long-running swarm controls.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexCompanyContext,
  CodexEnterpriseCommandCenter,
  CodexSwarmSummary,
} from "./types"
import { requestCodex as req } from "./core"

export const swarmsCodexApi = {
  getCommandCenter: (id: string) =>
    req<{ commandCenter: CodexEnterpriseCommandCenter; company: CodexCompanyContext }>(
      `/projects/${id}/command-center`,
      { cache: "no-store" },
    ),
  startSwarm: (
    id: string,
    body: {
      objective: string
      logicalAgents?: number
      maxConcurrency?: number
      maxConcurrentWriters?: number
      model?: string
      tier?: string
    },
  ) =>
    req<{ swarm: CodexSwarmSummary; commandCenter: CodexEnterpriseCommandCenter }>(
      `/projects/${id}/swarms`,
      // Large logical fleets (up to 10k tasks) can take >60s to plan + persist.
      { method: "POST", body: JSON.stringify(body), timeoutMs: 180_000 },
    ),
  pauseSwarm: (projectId: string, swarmId: string) =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/pause`,
      { method: "POST" },
    ),
  resumeSwarm: (projectId: string, swarmId: string) =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/resume`,
      { method: "POST" },
    ),
  cancelSwarm: (projectId: string, swarmId: string, reason = "cancelled_by_user") =>
    req<{ swarm: CodexSwarmSummary }>(
      `/projects/${projectId}/swarms/${swarmId}/cancel`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
} as const
