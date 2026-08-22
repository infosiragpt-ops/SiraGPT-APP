// Codex project lifecycle, workspace files, export, and preview operations.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type { CodexProject } from "./types"
import { requestCodex as req } from "./core"

export const projectsCodexApi = {
  listProjects: () => req<{ projects: CodexProject[] }>("/projects").then((r) => r.projects),
  createProject: (name: string, brief?: unknown, organizationId?: string | null) =>
    req<{ project: CodexProject }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, brief, organizationId: organizationId || null }),
    }).then((r) => r.project),
  createRepositoryProject: (name: string, repository: { url: string; sourceBranch?: string }, brief?: unknown) =>
    req<{ project: CodexProject }>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, brief, repository }),
      timeoutMs: 180_000,
    }).then((r) => r.project),
  getProject: (id: string) => req<{ project: CodexProject }>(`/projects/${id}`).then((r) => r.project),
  startPreview: (id: string, signal?: AbortSignal, run?: string | null) =>
    req<{ devUrl: string; previewUrl?: string; basePath?: string }>(
      `/projects/${id}/preview/start`,
      { method: "POST", timeoutMs: 110_000, signal, body: run ? JSON.stringify({ run }) : undefined },
    ),
  previewStatus: (id: string, signal?: AbortSignal, run?: string | null) =>
    req<any>(`/projects/${id}/preview/status${run ? `?run=${encodeURIComponent(run)}` : ""}`, { cache: "no-store", signal }),
  stopPreview: (id: string, run?: string | null) =>
    req<{ ok: boolean }>(`/projects/${id}/preview/stop`, { method: "POST", body: run ? JSON.stringify({ run }) : undefined }),
  exportProject: (id: string) => req<{ ok: boolean; project: string; files: number; hostPath: string }>(`/projects/${id}/export`, { method: "POST" }),
  listFiles: (id: string, run?: string | null) =>
    req<{ files: string[] }>(`/projects/${id}/files${run ? `?run=${encodeURIComponent(run)}` : ""}`).then((r) => r.files),
  execInProject: (id: string, command: string, run?: string | null) =>
    req<{ ok?: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }>(
      `/projects/${id}/files?command=${encodeURIComponent(command)}${run ? `&run=${encodeURIComponent(run)}` : ""}`,
    ),
  // Workspace import (browser → Codex project): push the local files into the
  // project BEFORE an iterate run so the agent edits the tree the user sees.
  importFiles: (id: string, files: Array<{ path: string; content: string }>, run?: string | null) =>
    req<{ ok: boolean; written: number }>(`/projects/${id}/files`, { method: "POST", body: JSON.stringify({ files, run: run || undefined }) }),
  readFileContent: (id: string, path: string, run?: string | null) =>
    req<{ ok: boolean; path: string; content: string }>(`/projects/${id}/file?path=${encodeURIComponent(path)}${run ? `&run=${encodeURIComponent(run)}` : ""}`),
} as const
