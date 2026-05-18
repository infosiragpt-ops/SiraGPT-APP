"use client"

/**
 * EditorPanel — middle column. URL pill + tabs across the top, code
 * surface underneath. The actual code editor is loaded lazily because
 * the underlying library is heavy and the rest of the workspace should
 * be usable while it hydrates. We default to a textarea with mono
 * styling as a no-dependency fallback so the page always renders.
 */

import * as React from "react"
import { FileCode2, FilePlus2, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

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
  } = useCodeWorkspace()
  // Current page URL shown as a browser-style address in the tab bar.
  // Reads `window.location.href` after mount (SSR-safe) and refreshes
  // on `popstate` so it tracks back/forward navigation without a full
  // route remount. We never write to it — it's purely a display.
  const [pageUrl, setPageUrl] = React.useState<string>("")
  React.useEffect(() => {
    if (typeof window === "undefined") return
    const sync = () => setPageUrl(window.location.href)
    sync()
    window.addEventListener("popstate", sync)
    return () => window.removeEventListener("popstate", sync)
  }, [])

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

  // Cmd/Ctrl+S still flushes the active file to disk via the keyboard
  // handler below — the visible Save button was removed, but persisting
  // on-demand is cheap to keep and matches user muscle memory.
  const handleSave = React.useCallback(async () => {
    await saveFileToWorkspace(activeFile?.path)
  }, [activeFile?.path, saveFileToWorkspace])

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
          <div
            className="flex h-7 min-w-0 max-w-[260px] shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 text-[11px] text-muted-foreground"
            title={pageUrl || "URL del workspace"}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
            <span className="truncate font-mono">
              {pageUrl || "http://localhost:3000/code"}
            </span>
          </div>
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
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
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

type CodeAreaProps = {
  value: string
  language: string
  onChange: (value: string) => void
  path: string
}

// Plain-textarea editor — first paint surface AND fallback when the
// Monaco bundle fails to load (offline build, slow network, library
// regression). Keeps the page interactive without shipping the ~2 MB
// Monaco chunk on the critical path.
function TextareaCodeArea({ value, language, onChange, path }: CodeAreaProps) {
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

// Lazy Monaco swap-in. Renders the textarea immediately so the user
// can start typing during the network round-trip; once the Monaco
// chunk loads we swap to the richer editor. If the import fails (rare)
// we stay on the textarea — the user never sees a broken state.
//
// Why not `next/dynamic` directly: dynamic's `loading` prop receives
// no parent props, so the fallback couldn't render with the live value.
// A local effect-driven swap keeps the value consistent across the
// boundary.
function CodeArea(props: CodeAreaProps) {
  const [MonacoComponent, setMonacoComponent] = React.useState<
    React.ComponentType<CodeAreaProps> | null
  >(null)

  React.useEffect(() => {
    let cancelled = false
    import("./monaco-code-area")
      .then((mod) => {
        if (cancelled) return
        setMonacoComponent(() => mod.default)
      })
      .catch(() => {
        // Stay on the textarea fallback. The error is intentionally
        // swallowed — surfacing it to the user gives them no useful
        // recovery option (the textarea still works).
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (MonacoComponent) return <MonacoComponent {...props} />
  return <TextareaCodeArea {...props} />
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
