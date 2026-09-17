// Agent runs, resumable sessions, transcript access, and plan approval.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexRun,
  CodexSessionSnapshot,
  CodexTranscriptEntry,
} from "./types"
import { arrayOrEmpty, requestCodex as req } from "./core"

export const runsCodexApi = {
  createRun: (projectId: string, body: { mode: "plan" | "build"; prompt?: string; model?: string; tier?: string; reasoningEffort?: string; planRunId?: string; autoExecute?: boolean }) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.run),
  listRuns: (projectId: string) =>
    req<{ runs?: unknown }>(`/projects/${projectId}/runs`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexRun>(r?.runs)),
  getRun: (projectId: string, runId: string) => req<{ run: CodexRun }>(`/projects/${projectId}/runs/${runId}`).then((r) => r.run),
  cancelRun: (runId: string) => req<{ run: CodexRun }>(`/runs/${runId}/cancel`, { method: "POST" }).then((r) => r.run),
  cancelRunFamily: (runId: string) => req<{ runs: CodexRun[]; cancelledRunIds: string[] }>(
    `/runs/${runId}/cancel-family`,
    { method: "POST" },
  ),
  generateRunSummaryAudio: (runId: string) =>
    req<{
      audio: {
        audioUrl: string
        mime: "audio/mpeg"
        sizeBytes: number
        characters: number
        voiceId: string | null
        modelId: string | null
      }
      cached: boolean
    }>(`/runs/${runId}/summary-audio`, { method: "POST", timeoutMs: 130_000 }),
  resolveToolPermission: (runId: string, permissionId: string, decision: "allow" | "deny") =>
    req<{ run: CodexRun }>(`/runs/${runId}/tool-permission`, {
      method: "POST",
      body: JSON.stringify({ permissionId, decision }),
    }).then((r) => r.run),
  getTranscript: (projectId: string, runId: string, afterSeq = 0, limit = 200) =>
    req<{ transcript: { sessionId: string; entries: CodexTranscriptEntry[]; malformed: number; firstSeq: number | null; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/transcript?afterSeq=${afterSeq}&limit=${limit}`,
      { cache: "no-store" },
    ).then((r) => r.transcript),
  continueSession: (projectId: string, runId: string, afterSeq?: number) =>
    req<{ session: { ok: boolean; sessionId: string; resumable: boolean; snapshot: CodexSessionSnapshot | null; cursorSeq: number; tail: CodexTranscriptEntry[] } }>(
      `/projects/${projectId}/runs/${runId}/session/continue`,
      { method: "POST", body: JSON.stringify(afterSeq == null ? {} : { afterSeq }) },
    ).then((r) => r.session),
  forkSession: (projectId: string, runId: string, atSeq?: number) =>
    req<{ session: { ok: boolean; sourceSessionId: string; sessionId: string; entries: number; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/session/fork`,
      { method: "POST", body: JSON.stringify(atSeq == null ? {} : { atSeq }) },
    ).then((r) => r.session),
  rewindSession: (projectId: string, runId: string, toSeq: number, checkpointId?: string) =>
    req<{ session: { ok: boolean; sessionId: string; toSeq: number; entries: number; lastSeq: number | null } }>(
      `/projects/${projectId}/runs/${runId}/session/rewind`,
      { method: "POST", body: JSON.stringify({ toSeq, ...(checkpointId ? { checkpointId } : {}) }) },
    ).then((r) => r.session),

  approvePlan: (
    projectId: string,
    planRunId: string,
    tier?: string,
    opts?: { autoExecute?: boolean; model?: string; reasoningEffort?: string },
  ) =>
    req<{ run: CodexRun }>(`/projects/${projectId}/runs`, {
      method: "POST",
      body: JSON.stringify({
        mode: "build",
        planRunId,
        tier,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(opts?.autoExecute ? { autoExecute: true } : {}),
      }),
    }).then((r) => r.run),
} as const
