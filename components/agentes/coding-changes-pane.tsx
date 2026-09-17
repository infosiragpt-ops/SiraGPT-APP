"use client"

/**
 * CodingChangesPane — «Cambios» del repositorio vinculado al chat de /agentes
 * (Etapa 7 de paridad con Claude Code): archivos cambiados frente a la rama
 * base, diff unificado por archivo y «Crear PR» con la cuenta de GitHub del
 * usuario. Habla con GET /projects/:id/changes y
 * POST /projects/:id/github/publish-workspace; el cliente nunca elige repo ni
 * rama base (salen del brief del proyecto). Crear el PR es en dos pasos: el
 * backend responde 428 con el plan (sin mutar nada) y solo con `confirm`
 * deja los cambios en `run/agentes-…` y abre el PR. Nunca push a la base.
 */

import * as React from "react"
import { ExternalLink, GitBranch, GitPullRequest, RefreshCw } from "lucide-react"

import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { projectsCodexApi } from "@/lib/codex/api/projects"
import type {
  CodexPublishWorkspacePlan,
  CodexPublishWorkspaceResult,
  CodexSourceControl,
  CodexWorkspaceChangeFile,
  CodexWorkspaceChanges,
} from "@/lib/codex/api/types"
import { cn } from "@/lib/utils"

export type CodingChangesPaneProps = {
  projectId: string | null
  sourceControl?: CodexSourceControl | null
  /** Sube cuando el árbol/contenido del proyecto cambia (el shell lo mantiene). */
  fileVersion: number
  onOpenFile?: (path: string) => void
}

export type DiffSection = { path: string; text: string }

/** Parte un diff unificado en secciones por archivo (`diff --git a/x b/y`; y = ruta final). */
export function splitUnifiedDiff(diff: string): DiffSection[] {
  const lines = String(diff || "").split("\n")
  const sections: DiffSection[] = []
  let current: DiffSection | null = null
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      if (current) sections.push(current)
      current = { path: m[2], text: line }
      continue
    }
    // «Binary files … differ» sin cabecera diff --git (o de otro archivo): sección propia.
    const bin = line.match(/^Binary files (?:\/dev\/null|a\/.+?) and b\/(.+) differ$/)
    if (bin && (!current || current.path !== bin[1])) {
      if (current) sections.push(current)
      current = { path: bin[1], text: line }
      continue
    }
    if (!current) {
      if (!line.trim()) continue
      current = { path: "", text: line }
      continue
    }
    current.text += `\n${line}`
  }
  if (current) sections.push(current)
  return sections
}

const STATUS_LABEL: Record<CodexWorkspaceChangeFile["status"], { short: string; label: string; tone: string }> = {
  added: { short: "A", label: "Añadido", tone: "text-emerald-600 dark:text-emerald-400" },
  modified: { short: "M", label: "Modificado", tone: "text-amber-600 dark:text-amber-400" },
  deleted: { short: "D", label: "Eliminado", tone: "text-rose-600 dark:text-rose-400" },
  renamed: { short: "R", label: "Renombrado", tone: "text-sky-600 dark:text-sky-400" },
  copied: { short: "C", label: "Copiado", tone: "text-sky-600 dark:text-sky-400" },
  typechange: { short: "T", label: "Tipo cambiado", tone: "text-amber-600 dark:text-amber-400" },
  conflict: { short: "U", label: "Conflicto", tone: "text-rose-600 dark:text-rose-400" },
  untracked: { short: "?", label: "Nuevo (sin seguimiento)", tone: "text-emerald-600 dark:text-emerald-400" },
}

function publishErrorMessage(err: unknown): string {
  const e = err as { status?: number; body?: { error?: string; message?: string }; message?: string }
  const code = e?.body?.error || ""
  switch (code) {
    case "github_auth_required":
      return "Conecta tu cuenta de GitHub para crear el PR desde el chat."
    case "base_branch_diverged":
      return "La rama base avanzó en GitHub. Vuelve a vincular el repo o actualiza el proyecto antes de publicar."
    case "pull_request_sensitive_path":
      return "Hay un archivo sensible (.env, claves) entre los cambios. Quítalo antes de crear el PR."
    case "pull_request_too_large":
    case "pull_request_file_too_large":
      return "El PR es demasiado grande para publicarlo desde el chat."
    case "repository_not_allowlisted":
      return "El servidor no permite publicar en este repositorio (CODEX_SELF_HOST_GIT_HOSTS)."
    case "runner_unreachable":
      return "El runner de proyectos no responde. Inténtalo de nuevo en unos segundos."
    default:
      return e?.body?.message || e?.message || "No se pudo crear el PR."
  }
}

export function CodingChangesPane({ projectId, sourceControl = null, fileVersion, onOpenFile }: CodingChangesPaneProps) {
  const [changes, setChanges] = React.useState<CodexWorkspaceChanges | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const [plan, setPlan] = React.useState<CodexPublishWorkspacePlan | null>(null)
  const [publishing, setPublishing] = React.useState(false)
  const [publishError, setPublishError] = React.useState("")
  const [result, setResult] = React.useState<CodexPublishWorkspaceResult | null>(null)
  const repoLinked = Boolean(projectId && sourceControl)

  const load = React.useCallback(async () => {
    if (!projectId || !sourceControl) return
    setLoading(true)
    setError("")
    try {
      const out = await projectsCodexApi.getWorkspaceChanges(projectId)
      setChanges(out)
      setSelectedPath((prev) => (prev && out.files.some((f) => f.path === prev) ? prev : null))
    } catch (err) {
      setError(publishErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [projectId, sourceControl])

  React.useEffect(() => {
    setChanges(null)
    setPlan(null)
    setResult(null)
    setPublishError("")
    if (!repoLinked) return
    void load()
    // fileVersion: el shell lo sube cuando el agente o el usuario cambian archivos.
  }, [load, fileVersion, repoLinked])

  const sections = React.useMemo(() => splitUnifiedDiff(changes?.diff || ""), [changes?.diff])
  const visibleSections = React.useMemo(
    () => (selectedPath ? sections.filter((s) => s.path === selectedPath) : sections),
    [sections, selectedPath],
  )

  async function handleCreatePr() {
    if (!projectId || publishing) return
    setPublishing(true)
    setPublishError("")
    setResult(null)
    try {
      const out = await projectsCodexApi.publishWorkspace(projectId, { title: title.trim() || undefined, confirm: false })
      // 200 solo cuando no hay cambios.
      setPlan(out.plan)
    } catch (err) {
      const e = err as { status?: number; body?: { plan?: CodexPublishWorkspacePlan } }
      if (e?.status === 428 && e.body?.plan) setPlan(e.body.plan)
      else setPublishError(publishErrorMessage(err))
    } finally {
      setPublishing(false)
    }
  }

  async function handleConfirmPr() {
    if (!projectId || publishing) return
    setPublishing(true)
    setPublishError("")
    try {
      const out = await projectsCodexApi.publishWorkspace(projectId, { title: title.trim() || undefined, confirm: true })
      setResult(out)
      setPlan(null)
      await load()
    } catch (err) {
      setPublishError(publishErrorMessage(err))
    } finally {
      setPublishing(false)
    }
  }

  if (!projectId) {
    return <p className="p-3 text-xs text-muted-foreground">Abre un proyecto para ver sus cambios.</p>
  }
  if (!sourceControl) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="agentes-coding-changes-unlinked">
        Vincula un repositorio de GitHub a este chat para ver los cambios frente a su rama base y crear un PR.
      </p>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="agentes-coding-changes">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">
          {changes ? (
            <>
              <span className="font-medium text-foreground">{changes.head.branch || changes.head.sha.slice(0, 7)}</span>
              {" → "}
              {changes.base.branch}
              {changes.head.ahead > 0 ? ` · ${changes.head.ahead} commit${changes.head.ahead === 1 ? "" : "s"} por delante` : ""}
            </>
          ) : (
            sourceControl.sourceBranch || "rama base"
          )}
        </span>
        {changes ? (
          <span className="text-muted-foreground" data-testid="agentes-coding-changes-summary">
            {changes.filesChanged} archivo{changes.filesChanged === 1 ? "" : "s"} ·{" "}
            <span className="text-emerald-600 dark:text-emerald-400">+{changes.additions}</span>{" "}
            <span className="text-rose-600 dark:text-rose-400">−{changes.deletions}</span>
          </span>
        ) : null}
        {loading ? <ThinkingIndicator size="xs" label="Cargando cambios" /> : null}
        <button
          type="button"
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-border px-2"
          onClick={() => void load()}
          disabled={loading}
          data-testid="agentes-coding-changes-refresh"
        >
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {error ? (
        <p className="border-b border-border px-3 py-1.5 text-destructive" role="alert" data-testid="agentes-coding-changes-error">
          {error}
        </p>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(160px,220px)_minmax(0,1fr)]">
        <ul className="min-h-0 overflow-auto border-r border-border" data-testid="agentes-coding-changes-files">
          {changes && changes.files.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground" data-testid="agentes-coding-changes-empty">
              Sin cambios frente a {changes.base.branch}.
            </li>
          ) : null}
          {changes?.files.map((file) => {
            const meta = STATUS_LABEL[file.status] || STATUS_LABEL.modified
            const active = selectedPath === file.path
            return (
              <li key={file.path}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted/60",
                    active && "bg-muted",
                  )}
                  onClick={() => setSelectedPath(active ? null : file.path)}
                  onDoubleClick={() => onOpenFile?.(file.path)}
                  title={`${meta.label}${file.from ? ` (antes ${file.from})` : ""}${file.uncommitted ? " · sin commit" : ""}`}
                  aria-pressed={active}
                  data-testid="agentes-coding-changes-file"
                >
                  <span className={cn("w-3 shrink-0 font-mono font-semibold", meta.tone)}>{meta.short}</span>
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {file.binary ? "bin" : `+${file.additions} −${file.deletions}`}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>

        <pre
          className="min-h-0 overflow-auto p-2 font-mono text-[11px] leading-relaxed"
          data-testid="agentes-coding-changes-diff"
        >
          {visibleSections.length === 0 && changes ? (
            <span className="text-muted-foreground">
              {selectedPath ? "Sin diff para este archivo." : changes.files.length ? "Sin diff textual." : ""}
            </span>
          ) : null}
          {visibleSections.map((section, i) => (
            <div key={`${section.path}:${i}`} data-testid="agentes-coding-changes-section" data-path={section.path}>
              {section.text.split("\n").map((line, j) => (
                <div
                  key={j}
                  className={
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                        : line.startsWith("@@")
                          ? "text-sky-600 dark:text-sky-400"
                          : line.startsWith("diff --git")
                            ? "mt-2 font-semibold text-foreground"
                            : "text-muted-foreground"
                  }
                >
                  {line || " "}
                </div>
              ))}
            </div>
          ))}
          {changes?.truncated ? <div className="mt-2 text-amber-600 dark:text-amber-400">Diff truncado por tamaño.</div> : null}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-1.5" data-testid="agentes-coding-changes-pr">
        <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        {result?.pullRequest?.url ? (
          <a
            href={result.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium underline-offset-2 hover:underline"
            data-testid="agentes-coding-changes-pr-link"
          >
            PR #{result.pullRequest.number} abierto
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : null}
        {result && !result.pullRequest ? (
          <span className="text-muted-foreground" data-testid="agentes-coding-changes-pr-none">
            No había cambios que publicar.
          </span>
        ) : null}
        {!result ? (
          <input
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`Título del PR (base ${sourceControl.sourceBranch || "main"})`}
            aria-label="Título del PR"
            maxLength={120}
            disabled={publishing}
            data-testid="agentes-coding-changes-pr-title"
          />
        ) : null}
        {plan ? (
          <span className="text-muted-foreground" data-testid="agentes-coding-changes-plan">
            {plan.status === "no_changes"
              ? "Sin cambios que publicar."
              : plan.status === "github_auth_required"
                ? "Conecta GitHub para crear el PR."
                : `${plan.files ?? 0} archivo${plan.files === 1 ? "" : "s"} → ${plan.branch} contra ${plan.base}`}
          </span>
        ) : null}
        {publishing ? <ThinkingIndicator size="xs" label="Publicando" /> : null}
        {plan && plan.status === "ready_to_publish" ? (
          <button
            type="button"
            className="h-7 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50"
            onClick={handleConfirmPr}
            disabled={publishing}
            data-testid="agentes-coding-changes-pr-confirm"
          >
            Confirmar y abrir PR
          </button>
        ) : !result ? (
          <button
            type="button"
            className="h-7 rounded-md border border-border px-3 disabled:opacity-50"
            onClick={handleCreatePr}
            disabled={publishing || !changes || changes.files.length === 0}
            data-testid="agentes-coding-changes-pr-create"
          >
            Crear PR
          </button>
        ) : null}
        {publishError ? (
          <span className="text-destructive" role="alert" data-testid="agentes-coding-changes-pr-error">
            {publishError}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default CodingChangesPane
