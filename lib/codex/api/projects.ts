// Codex project lifecycle, workspace files, export, and preview operations.
// Kept behind the codexApi facade so existing callers retain one stable import.

import type {
  CodexChatBinding,
  CodexCloneResult,
  CodexProject,
  CodexPublishWorkspaceResult,
  CodexWorkspaceChanges,
} from "./types"
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
  // Clona un repo de GitHub (público, o privado con el OAuth guardado) y, con
  // `chatId`, lo deja vinculado a ese chat de /agentes. 180s: el fetch
  // --depth=1 de un repo grande puede tardar más que el timeout por defecto.
  cloneRepository: (input: { name: string; repoUrl: string; branch?: string; chatId?: string }) =>
    req<CodexCloneResult>("/projects/clone", {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: 180_000,
    }),
  // Vínculo chat↔proyecto (MVP programación web): un chat abre un proyecto
  // durable. 404 project_not_found ⇒ no hay proyecto vinculado todavía.
  getProjectByChat: (chatId: string) =>
    req<{ project: CodexProject; chatId: string }>(`/projects/by-chat/${encodeURIComponent(chatId)}`).then((r) => r.project),
  ensureProjectForChat: (chatId: string, name?: string) =>
    req<CodexChatBinding>(`/projects/by-chat/${encodeURIComponent(chatId)}`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
  // Etapa 7: cambios del workspace frente a la rama base del repo vinculado y
  // «Crear PR». Sin `confirm` el backend responde 428 con el plan (sin mutar).
  getWorkspaceChanges: (id: string, signal?: AbortSignal) =>
    req<CodexWorkspaceChanges>(`/projects/${id}/changes`, { cache: "no-store", timeoutMs: 60_000, signal }),
  publishWorkspace: (id: string, input: { title?: string; body?: string; confirm?: boolean }) =>
    req<CodexPublishWorkspaceResult>(`/projects/${id}/github/publish-workspace`, {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: 180_000,
    }),
  startPreview: (id: string, signal?: AbortSignal) =>
    req<{ devUrl: string; previewUrl?: string; basePath?: string }>(
      `/projects/${id}/preview/start`,
      { method: "POST", timeoutMs: 110_000, signal },
    ),
  previewStatus: (id: string, signal?: AbortSignal) =>
    req<any>(`/projects/${id}/preview/status`, { cache: "no-store", signal }),
  stopPreview: (id: string) => req<{ ok: boolean }>(`/projects/${id}/preview/stop`, { method: "POST" }),
  exportProject: (id: string) => req<{ ok: boolean; project: string; files: number; hostPath: string }>(`/projects/${id}/export`, { method: "POST" }),
  listFiles: (id: string) => req<{ files: string[] }>(`/projects/${id}/files`).then((r) => r.files),
  execInProject: (id: string, cmd: string | string[], run?: string | null, timeoutMs?: number) => {
    const parts = Array.isArray(cmd)
      ? cmd.map((a) => String(a))
      : (() => {
          // Legacy single-string callers: tokenize like a shell would so the
          // sandbox receives an argv array (no shell on the runner side).
          const s = String(cmd).trim()
          const out: string[] = []
          let cur = ""
          let quote: '"' | "'" | null = null
          for (const ch of s) {
            if (quote) {
              if (ch === quote) quote = null
              else cur += ch
              continue
            }
            if (ch === '"' || ch === "'") {
              quote = ch
              continue
            }
            if (/\s/.test(ch)) {
              if (cur) out.push(cur)
              cur = ""
              continue
            }
            cur += ch
          }
          if (cur) out.push(cur)
          return out
        })()
    return req<{ ok?: boolean; stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }>(
      `/projects/${id}/exec`,
      { method: "POST", body: JSON.stringify({ cmd: parts, ...(run ? { run } : {}), ...(timeoutMs ? { timeoutMs } : {}) }), timeoutMs: 130_000 },
    )
  },
  // Workspace import (browser → Codex project): push the local files into the
  // project BEFORE an iterate run so the agent edits the tree the user sees.
  importFiles: (id: string, files: Array<{ path: string; content: string }>) =>
    req<{ ok: boolean; written: number }>(`/projects/${id}/files`, { method: "POST", body: JSON.stringify({ files }) }),
  readFileContent: (id: string, path: string) => req<{ ok: boolean; path: string; content: string }>(`/projects/${id}/file?path=${encodeURIComponent(path)}`),
} as const
