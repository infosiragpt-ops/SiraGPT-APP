"use client"

/**
 * EditorPanel — middle column. Tabs across the top, content area
 * underneath. The actual code editor is loaded lazily because the
 * underlying library is heavy and the rest of the workspace should
 * be usable while it hydrates. We default to a textarea with mono
 * styling as a no-dependency fallback so the page always renders.
 *
 * The "preview" toggle on HTML/SVG files reuses the same iframe
 * pattern as ArtifactPanel without dragging in the chat side of the
 * app, since the chat artifact context lives elsewhere.
 */

import * as React from "react"
import { AlertCircle, ExternalLink, FileCode2, FilePlus2, Globe2, RefreshCw, RotateCcw, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"
import type { CodeFile, CodeFiles } from "@/lib/code-workspace-utils"

const PREVIEW_LANGUAGES = new Set(["html", "htm", "svg"])

export function EditorPanel() {
  const {
    files,
    activePath,
    setActiveTab,
    updateFile,
    focusChat,
    createFile,
    resetWorkspace,
    saveFileToWorkspace,
    workspaceSource,
  } = useCodeWorkspace()
  const [savedPing, setSavedPing] = React.useState(false)

  const activeFile = activePath ? files[activePath] : null
  const sortedPaths = React.useMemo(
    () => Object.keys(files).sort((a, b) => a.localeCompare(b)),
    [files],
  )

  const handleChange = React.useCallback(
    (value: string) => {
      if (!activeFile) return
      updateFile(activeFile.path, value)
    },
    [activeFile, updateFile],
  )

  const flashSaved = React.useCallback(() => {
    setSavedPing(true)
    window.setTimeout(() => setSavedPing(false), 800)
  }, [])

  const handleSave = React.useCallback(async () => {
    const ok = await saveFileToWorkspace(activeFile?.path)
    if (ok) flashSaved()
  }, [activeFile?.path, flashSaved, saveFileToWorkspace])

  const handleCreateFile = React.useCallback(() => {
    if (typeof window === "undefined") return
    const path = window.prompt("Nombre del archivo (incluye la ruta, p. ej. src/app.tsx)")
    if (!path) return
    createFile(path, "")
  }, [createFile])

  const handleResetWorkspace = React.useCallback(() => {
    if (typeof window === "undefined") return
    if (!window.confirm("Esto restaurará los archivos de ejemplo y descartará el workspace actual.")) return
    resetWorkspace()
  }, [resetWorkspace])

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      if (!isMod) return
      const key = e.key.toLowerCase()
      if (key === "s") {
        e.preventDefault()
        void handleSave()
      } else if (key === "l") {
        e.preventDefault()
        focusChat()
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [focusChat, handleSave])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Archivos
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {sortedPaths.length === 0 ? (
              <span className="px-2 text-xs text-muted-foreground">Sin archivos</span>
            ) : (
              sortedPaths.map((path) => (
                <FileSwitchButton
                  key={path}
                  path={path}
                  active={path === activePath}
                  onSelect={() => setActiveTab(path)}
                />
              ))
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleCreateFile}
            title="Nuevo archivo"
            aria-label="Nuevo archivo"
          >
            <FilePlus2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleResetWorkspace}
            title="Restaurar ejemplo"
            aria-label="Restaurar ejemplo"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={() => void handleSave()}
            title={
              workspaceSource.kind === "local-folder"
                ? `Guardar en ${workspaceSource.name} (Cmd/Ctrl+S)`
                : "Guardar workspace local (Cmd/Ctrl+S)"
            }
          >
            <Save className="h-3.5 w-3.5" />
            {savedPing ? "Guardado" : "Guardar"}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-[320px] flex-[1.05] border-r border-border/60">
          {!activeFile ? (
            <EmptyState />
          ) : (
            <CodeArea
              value={activeFile.content}
              language={activeFile.language}
              onChange={handleChange}
              path={activeFile.path}
            />
          )}
        </div>
        <VirtualBrowserPanel
          files={files}
          activePath={activePath}
          onOpenFile={setActiveTab}
        />
      </div>
    </div>
  )
}

function FileSwitchButton({
  path,
  active,
  onSelect,
}: {
  path: string
  active: boolean
  onSelect: () => void
}) {
  const label = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "h-7 max-w-[180px] shrink-0 truncate rounded-md px-2.5 text-left text-xs transition-colors",
        active
          ? "bg-foreground text-background shadow-sm"
          : "bg-muted/45 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      title={path}
      aria-label={`Abrir ${label}`}
    >
      {label}
    </button>
  )
}

function CodeArea({
  value,
  language,
  onChange,
  path,
}: {
  value: string
  language: string
  onChange: (value: string) => void
  path: string
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border/40 bg-muted/20 px-3 text-[11px] uppercase tracking-wide text-muted-foreground">
        <FileCode2 className="h-3 w-3" />
        <span className="truncate">{path}</span>
        <span className="ml-auto opacity-70">{language}</span>
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={cn(
          "min-h-0 flex-1 resize-none border-0 bg-background p-3 font-mono text-[13px] leading-6 text-foreground",
          "outline-none focus-visible:ring-0",
          "tab:tab-size-2",
        )}
        // Tabs as 2 spaces — matches the rest of the codebase. Browsers
        // do not honour `tab-size` on textarea unless we keep `tab-size`
        // CSS rather than the prose-style class above; we ship both.
        style={{ tabSize: 2 }}
      />
    </div>
  )
}

function VirtualBrowserPanel({
  files,
  activePath,
  onOpenFile,
}: {
  files: CodeFiles
  activePath: string | null
  onOpenFile: (path: string) => void
}) {
  const [refreshKey, setRefreshKey] = React.useState(0)
  const previewFile = React.useMemo(
    () => selectPreviewFile(files, activePath),
    [activePath, files],
  )
  const document = React.useMemo(
    () => (previewFile ? buildPreviewDocument(previewFile, files) : ""),
    [files, previewFile],
  )
  const updatedAt = previewFile?.updatedAt ?? 0
  const address = previewFile ? `sira://workspace/${previewFile.path}` : "sira://workspace"

  return (
    <section className="flex min-w-[360px] flex-1 flex-col bg-zinc-50/70" aria-label="Navegador virtual">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-2">
        <div className="flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Globe2 className="h-3.5 w-3.5 text-sky-500" />
          Navegador virtual
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border/70 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          <span className="truncate font-mono">{address}</span>
        </div>
        {previewFile ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenFile(previewFile.path)}
            title={`Editar ${previewFile.path}`}
            aria-label={`Editar ${previewFile.path}`}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={() => setRefreshKey((v) => v + 1)}
          title="Recargar vista"
          aria-label="Recargar vista"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <div className="h-full overflow-hidden rounded-xl border border-border/70 bg-white shadow-sm">
          {previewFile ? (
            <iframe
              key={`${previewFile.path}-${updatedAt}-${refreshKey}`}
              title={`Navegador virtual: ${previewFile.path}`}
              sandbox="allow-scripts allow-forms allow-modals"
              className="h-full w-full bg-white"
              srcDoc={document}
            />
          ) : (
            <VirtualBrowserEmpty />
          )}
        </div>
      </div>
    </section>
  )
}

function VirtualBrowserEmpty() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-xs">
        <AlertCircle className="mx-auto mb-3 h-6 w-6 opacity-60" />
        <p>No hay ningún archivo HTML o SVG para previsualizar.</p>
        <p className="mt-1 text-xs">Crea `index.html` desde el chat para ver la web aquí.</p>
      </div>
    </div>
  )
}

function selectPreviewFile(files: CodeFiles, activePath: string | null): CodeFile | null {
  const active = activePath ? files[activePath] : null
  if (active && PREVIEW_LANGUAGES.has(active.language)) return active
  if (files["index.html"]) return files["index.html"]
  return Object.values(files).find((file) => PREVIEW_LANGUAGES.has(file.language)) ?? null
}

function buildPreviewDocument(file: CodeFile, files: CodeFiles): string {
  if (file.language === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8" />\n<style>html,body{margin:0;min-height:100%;display:grid;place-items:center;background:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}body{padding:24px}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${file.content}</body></html>`
  }

  const trimmed = file.content.trimStart()
  const html = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)
    ? file.content
    : `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body style="margin:0;padding:0">${file.content}</body></html>`

  return inlineWorkspaceAssets(html, file.path, files)
}

function inlineWorkspaceAssets(html: string, htmlPath: string, files: CodeFiles): string {
  const withStyles = html.replace(
    /<link\b([^>]*?)rel=(["'])stylesheet\2([^>]*?)>/gi,
    (match, before: string, quote: string, after: string) => {
      const attrs = `${before} ${after}`
      const href = readHtmlAttribute(attrs, "href")
      if (!href) return match
      const asset = resolveWorkspaceAsset(href, htmlPath, files)
      if (!asset) return match
      return `<style data-siragpt-src="${escapeHtml(asset.path)}">\n${asset.content}\n</style>`
    },
  )

  return withStyles.replace(
    /<script\b([^>]*?)src=(["'])(.*?)\2([^>]*)>\s*<\/script>/gi,
    (match, before: string, _quote: string, src: string, after: string) => {
      const asset = resolveWorkspaceAsset(src, htmlPath, files)
      if (!asset) return match
      const attrs = `${before} ${after}`.replace(/\s+src=(["']).*?\1/i, "")
      return `<script${attrs} data-siragpt-src="${escapeHtml(asset.path)}">\n${asset.content}\n</script>`
    },
  )
}

function readHtmlAttribute(attrs: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*([\"'])(.*?)\\1`, "i")
  return attrs.match(pattern)?.[2] ?? null
}

function resolveWorkspaceAsset(source: string, fromPath: string, files: CodeFiles): CodeFile | null {
  if (!source || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith("//")) return null
  const cleanSource = source.split("#")[0].split("?")[0].replace(/^\.?\//, "")
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : ""
  const candidates = [
    cleanSource,
    `${fromDir}${cleanSource}`.replace(/\/+/g, "/"),
  ]
  for (const candidate of candidates) {
    const normalized = normalizeRelativePath(candidate)
    if (files[normalized]) return files[normalized]
  }
  return null
}

function normalizeRelativePath(path: string): string {
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div>
        <FileCode2 className="mx-auto mb-3 h-6 w-6 opacity-60" />
        <p>Selecciona un archivo en la barra superior para empezar a editar.</p>
      </div>
    </div>
  )
}
