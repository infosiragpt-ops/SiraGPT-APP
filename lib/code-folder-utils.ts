"use client"

/**
 * Pure helpers for the /code workspace URL + folder-loading failure modes.
 *
 * Kept out of app/code/page.tsx so the auth-redirect URL building and the
 * error classification are unit-testable without mounting the page.
 */

import { ProjectServiceError } from "./projects-service"

export type FolderLoadErrorKind =
  | "not_found" // 404 — project missing/deleted or not yours
  | "unauthorized" // 401 — session expired/missing
  | "forbidden" // 403 — owned by another user
  | "network" // fetch rejected (backend unreachable / CORS / offline)
  | "server" // 5xx
  | "unknown"

export type FolderLoadError = {
  kind: FolderLoadErrorKind
  message: string
  status?: number
}

/**
 * Route a failure while hydrating ?folder=<projectId> into a typed error the
 * page can present distinctly (not-found vs auth vs network vs server).
 */
export function classifyFolderLoadError(err: unknown): FolderLoadError {
  if (err instanceof ProjectServiceError) {
    const kind: FolderLoadErrorKind =
      err.kind === "unauthorized" || err.kind === "forbidden" || err.kind === "not_found"
        ? err.kind
        : err.kind === "server"
          ? "server"
          : err.kind === "network"
            ? "network"
            : "unknown"
    return {
      kind,
      message: err.message || `HTTP ${err.status ?? "error"}`,
      status: err.status,
    }
  }
  const raw = err instanceof Error ? err.message : String(err)
  return { kind: "network", message: raw || "Network error" }
}

/**
 * Build the `next` value for /auth/login so the browser returns to the exact
 * /code URL (with ?folder=… / ?local=…) the user came from, instead of a bare
 * `/code`. Accepts the raw `window.location.search` string or a URLSearchParams.
 */
export function buildCodeLoginNext(
  search: string | URLSearchParams | null | undefined,
): string {
  let qs = ""
  if (search instanceof URLSearchParams) {
    qs = search.toString()
  } else if (typeof search === "string" && search) {
    qs = search.replace(/^\?/, "")
  }
  return qs ? `/code?${qs}` : "/code"
}

/**
 * Encode the return path as a single `next` query value (login reads it back
 * with searchParams.get("next")), rejecting values that would escape /code.
 */
export function encodeLoginNext(returnPath: string): string {
  const clean =
    returnPath.startsWith("/") && !returnPath.startsWith("//") && !returnPath.startsWith("/api")
      ? returnPath
      : "/code"
  return encodeURIComponent(clean)
}

// ── Workspace file-source contract (Slice B) ─────────────────────────────
//
// The /code editor FS is NOT the same as Project.files on the server.
// Project.files are knowledge attachments (PDF/docs for RAG); they have no
// path/content suitable for the editor tree. Code for a server Project lives
// in browser localStorage namespaced by project id until Slice C adds remote
// persistence. This contract makes that explicit so the UI never pretends
// Project.files hydrate the tree.

export type WorkspaceFilePersistence = "browser" | "local-disk" | "server" | "none"

export type WorkspaceFileSourceKind = "starter" | "browser" | "local-folder" | "project"

export type ResolvedWorkspaceFileSource = {
  /** What owns this workspace session. */
  kind: WorkspaceFileSourceKind
  /** Where editor file bytes actually live. */
  persistence: WorkspaceFilePersistence
  /** Human label for the source badge / tree footer. */
  name: string
  /** True only when File System Access API is linked to a real folder. */
  linked: boolean
  /** Editor files currently known (localStorage / import count). */
  fileCount?: number
  /**
   * Count of server Project knowledge attachments (File rows). Never used
   * as the editor tree — surface only as metadata.
   */
  knowledgeFileCount?: number
  /**
   * True when the editor tree is intentionally empty of server code because
   * no remote code FS exists yet (browser-only project workspaces).
   */
  browserOnly: boolean
}

/**
 * Resolve the file-source contract after a successful Project GET.
 *
 * Does NOT map Project.files into editor paths — those are knowledge
 * attachments. Editor code uses Project.codeWorkspace (server) with a
 * localStorage cache (Slice C).
 */
export function resolveProjectFileSource(input: {
  name: string
  /** Number of knowledge File rows on the Project (metadata only). */
  knowledgeFileCount?: number
  /** Editor files already in localStorage for this project id. */
  editorFileCount?: number
  /** When false, server code-workspace is unavailable (offline / 5xx). */
  serverAvailable?: boolean
}): ResolvedWorkspaceFileSource {
  const knowledgeFileCount =
    typeof input.knowledgeFileCount === "number" && input.knowledgeFileCount >= 0
      ? input.knowledgeFileCount
      : 0
  const editorFileCount =
    typeof input.editorFileCount === "number" && input.editorFileCount >= 0
      ? input.editorFileCount
      : undefined
  const serverAvailable = input.serverAvailable !== false

  return {
    kind: "project",
    persistence: serverAvailable ? "server" : "browser",
    name: input.name || "Proyecto",
    linked: false,
    fileCount: editorFileCount,
    knowledgeFileCount,
    browserOnly: !serverAvailable,
  }
}

/**
 * Resolve the file-source contract for a local/desktop folder workspace.
 */
export function resolveLocalFolderFileSource(input: {
  name: string
  linked: boolean
  fileCount?: number
  skippedCount?: number
}): ResolvedWorkspaceFileSource {
  return {
    kind: input.linked ? "local-folder" : "browser",
    persistence: input.linked ? "local-disk" : "browser",
    name: input.name || "Carpeta local",
    linked: Boolean(input.linked),
    fileCount: input.fileCount,
    browserOnly: !input.linked,
  }
}

/**
 * Footer / badge copy for the file tree so the user sees the real source.
 */
export function workspaceSourceLabel(source: {
  kind: WorkspaceFileSourceKind | string
  linked?: boolean
  browserOnly?: boolean
  persistence?: WorkspaceFilePersistence | string
}): string {
  if (source.kind === "local-folder" || source.linked) {
    return "Sincronizado con carpeta local"
  }
  // Only server Projects get the project-scoped copy — a plain browser
  // workspace (no Project id) keeps the generic browser label even when
  // browserOnly is true.
  if (source.kind === "project") {
    if (source.persistence === "server" && !source.browserOnly) {
      return "Proyecto · servidor + este navegador"
    }
    return "Proyecto · solo en este navegador"
  }
  return "Solo en este navegador"
}

// ── Save contract (Slice C / F6) ─────────────────────────────────────────
//
// Modes:
//   - local-disk: File System Access API write to a linked folder
//   - server:     Project.codeWorkspace snapshot (owner-scoped API) + local cache
//   - browser:    localStorage only (fallback / non-project)
//   - noop:       nothing to save (no active file)
// Never confuses knowledge Project.files with the editor FS.

export type WorkspaceSaveMode = "local-disk" | "server" | "browser" | "noop"

export type WorkspaceSaveResult = {
  ok: boolean
  mode: WorkspaceSaveMode
  /** True only when the Project.codeWorkspace API accepted the write. */
  remote: boolean
  path?: string
  message: string
}

/**
 * Decide where a save action will actually write bytes.
 * `hasLinkedLocalFolder` must reflect the live File System Access handle.
 */
export function resolveWorkspaceSaveMode(
  source: {
    kind?: string
    linked?: boolean
    browserOnly?: boolean
    persistence?: string
  },
  hasLinkedLocalFolder: boolean,
): Exclude<WorkspaceSaveMode, "noop"> {
  if (
    (source.kind === "local-folder" || source.linked) &&
    hasLinkedLocalFolder &&
    source.persistence !== "browser"
  ) {
    return "local-disk"
  }
  if (source.kind === "project" && source.persistence === "server" && !source.browserOnly) {
    return "server"
  }
  return "browser"
}

/**
 * User-facing toast / status copy for a completed save.
 */
export function workspaceSaveMessage(
  mode: WorkspaceSaveMode,
  opts: { path?: string; folderName?: string } = {},
): string {
  if (mode === "local-disk") {
    const name = opts.folderName?.trim() || "carpeta local"
    return opts.path ? `${opts.path} guardado en ${name}.` : `Guardado en ${name}.`
  }
  if (mode === "server") {
    return opts.path
      ? `${opts.path} guardado en el proyecto (servidor).`
      : "Guardado en el proyecto (servidor)."
  }
  if (mode === "noop") {
    return "No hay archivo activo para guardar."
  }
  return "Guardado solo en este navegador (sin persistencia en el servidor)."
}

/**
 * Short action label for UI (buttons, tooltips, command palette).
 */
export function workspaceSaveActionLabel(
  mode: Exclude<WorkspaceSaveMode, "noop"> | WorkspaceSaveMode,
): string {
  if (mode === "local-disk") return "Guardar en carpeta local"
  if (mode === "server") return "Guardar en el proyecto"
  if (mode === "noop") return "Guardar"
  return "Guardar en este navegador"
}

/**
 * Capability summary exposed to the workspace UI.
 */
export function workspaceSaveCapability(
  source: {
    kind?: string
    linked?: boolean
    browserOnly?: boolean
    persistence?: string
  },
  hasLinkedLocalFolder: boolean,
): {
  mode: Exclude<WorkspaceSaveMode, "noop">
  remote: boolean
  label: string
  description: string
} {
  const mode = resolveWorkspaceSaveMode(source, hasLinkedLocalFolder)
  if (mode === "local-disk") {
    return {
      mode,
      remote: false,
      label: workspaceSaveActionLabel(mode),
      description: "Escribe el archivo en la carpeta del disco enlazada.",
    }
  }
  if (mode === "server") {
    return {
      mode,
      remote: true,
      label: workspaceSaveActionLabel(mode),
      description:
        "Guarda el árbol de código del editor en el proyecto (servidor) y en este navegador. No son los adjuntos de conocimiento.",
    }
  }
  return {
    mode,
    remote: false,
    label: workspaceSaveActionLabel(mode),
    description:
      source.kind === "project"
        ? "El servidor de código no está disponible; solo se guarda en este navegador."
        : "Los cambios ya se auto-guardan en este navegador; no hay copia en el servidor.",
  }
}

/**
 * Local-first merge for Project code workspaces (Slice C).
 * - Prefer local editor files when present (active session).
 * - Otherwise hydrate from the server snapshot.
 */
export function pickCodeWorkspaceHydration(input: {
  localFileCount: number
  serverFileCount: number
}): "local" | "server" | "empty" {
  if (input.localFileCount > 0) return "local"
  if (input.serverFileCount > 0) return "server"
  return "empty"
}

// ── Slice C: persistence status chip ─────────────────────────────────────

export type WorkspacePersistenceTone = "local" | "server" | "project" | "browser" | "none"

export type WorkspacePersistenceStatus = {
  /** Short chip / menu label. */
  label: string
  tone: WorkspacePersistenceTone
  /** Longer explanation for title tooltips. */
  detail: string
}

/**
 * Status for top-bar / project menu — distinguishes local-disk link,
 * Project server code snapshot, and bare browser.
 */
export function workspacePersistenceStatus(source: {
  kind?: WorkspaceFileSourceKind | string | null
  linked?: boolean
  browserOnly?: boolean
  persistence?: WorkspaceFilePersistence | string
} | null | undefined): WorkspacePersistenceStatus {
  if (!source || !source.kind) {
    return {
      label: "Sin proyecto activo",
      tone: "none",
      detail: "Abre un proyecto o carpeta local para empezar.",
    }
  }
  if (source.kind === "local-folder" || source.linked) {
    return {
      label: "Sincronizado con carpeta local",
      tone: "local",
      detail: "Los archivos se escriben en la carpeta de tu equipo al guardar.",
    }
  }
  if (source.kind === "project") {
    if (source.persistence === "server" && !source.browserOnly) {
      return {
        label: "Código en el servidor + navegador",
        tone: "server",
        detail:
          "El árbol del editor se guarda en Project.codeWorkspace (servidor) y en localStorage. Los adjuntos de conocimiento (Project.files) no son el árbol.",
      }
    }
    return {
      label: "Código solo en este navegador",
      tone: "project",
      detail:
        "El servidor de código no respondió; el editor usa solo localStorage de este navegador.",
    }
  }
  return {
    label: "Solo en este navegador",
    tone: "browser",
    detail: "Los archivos del editor se guardan en localStorage de este navegador.",
  }
}


