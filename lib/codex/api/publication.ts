// Published project releases and rollback operations.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexPublication,
  CodexPublicationRelease,
} from "./types"
import { requestCodex as req } from "./core"

export const publicationCodexApi = {
  getPublication: (projectId: string) =>
    req<{ publication: CodexPublication }>(`/projects/${projectId}/publication`, { cache: "no-store" })
      .then((r) => r.publication),
  publishProject: (projectId: string, checkpointId?: string) =>
    req<{ ok: boolean; publication: CodexPublication; release: CodexPublicationRelease; buildLog: string }>(
      `/projects/${projectId}/publication`,
      {
        method: "POST",
        body: JSON.stringify(checkpointId ? { checkpointId } : {}),
        timeoutMs: 240_000,
      },
    ),
  rollbackPublication: (projectId: string, releaseId: string) =>
    req<{ ok: boolean; publication: CodexPublication; release: CodexPublicationRelease }>(
      `/projects/${projectId}/publication/rollback`,
      { method: "POST", body: JSON.stringify({ releaseId }), timeoutMs: 60_000 },
    ),
} as const
