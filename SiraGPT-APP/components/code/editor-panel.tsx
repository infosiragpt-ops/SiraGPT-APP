"use client"

/**
 * EditorPanel — middle column. URL pill + tabs across the top, code
 * surface underneath. The actual code editor is loaded lazily because
 * the underlying library is heavy and the rest of the workspace should
 * be usable while it hydrates. We default to a textarea with mono
 * styling as a no-dependency fallback so the page always renders.
 */

import * as React from "react"
import { FileCode2, FilePlus2, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

export function EditorPanel() {
  const {
    files,
    activePath,
    updateFile,
    focusChat,
    createFile,
    saveFileToWorkspace,
  } = useCodeWorkspace()

  const activeFile = activePath ? files[activePath] : null

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
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {!activeFile ? (
            <EmptyState
              hasFiles={Object.keys(files).length > 0}
              onCreateFile={handleCreateFile}
              onFocusChat={focusChat}
            />
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
function TextareaCodeArea({ value, onChange }: CodeAreaProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
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

function EmptyState({
  hasFiles,
  onCreateFile,
  onFocusChat,
}: {
  hasFiles: boolean
  onCreateFile: () => void
  onFocusChat: () => void
}) {
  // Files exist but none is open — gentle nudge to pick a tab.
  if (hasFiles) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <div>
          <FileCode2 className="mx-auto mb-3 h-6 w-6 opacity-60" />
          <p>Selecciona un archivo en la barra superior para empezar a editar.</p>
        </div>
      </div>
    )
  }

  // Blank project — the clean canvas a new workspace opens in. Invite
  // the user to start from zero: create a file, or let the AI chat build
  // it. No example code or sample folders to delete first.
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/60">
          <Sparkles className="h-6 w-6 text-muted-foreground" />
        </div>
        <h2 className="mb-1.5 text-base font-semibold text-foreground">Proyecto en blanco</h2>
        <p className="mb-5 text-sm text-muted-foreground">
          Empieza desde cero: crea tu primer archivo o pídele al chat de IA que construya la app por ti.
        </p>
        <div className="flex items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={onCreateFile}>
            <FilePlus2 className="mr-1.5 h-3.5 w-3.5" />
            Nuevo archivo
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onFocusChat}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />
            Pedir a la IA
          </Button>
        </div>
      </div>
    </div>
  )
}
