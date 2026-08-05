// Checkpoint history, diffs, and rollback operations.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexCheckpoint,
  CodexCheckpointDiff,
} from "./types"
import { arrayOrEmpty, requestCodex as req } from "./core"

export const checkpointsCodexApi = {
  rollbackCheckpoint: (checkpointId: string) => req<{ ok: boolean; commitSha: string; restarted: boolean }>(`/checkpoints/${checkpointId}/rollback`, { method: "POST" }),
  getCheckpointDiff: (checkpointId: string) => req<CodexCheckpointDiff>(`/checkpoints/${checkpointId}/diff`),
  listCheckpoints: (projectId: string) =>
    req<{ checkpoints?: unknown }>(`/projects/${projectId}/checkpoints`, { cache: "no-store" })
      .then((r) => arrayOrEmpty<CodexCheckpoint>(r?.checkpoints)),
} as const
