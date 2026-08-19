"use client"

import * as React from "react"
import { FileSearch } from "lucide-react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useCodeWorkspace } from "@/lib/code-workspace-context"

type Hit = { path: string; snippet?: string }

export function SearchPanel() {
  const { files, openFile } = useCodeWorkspace()
  const [query, setQuery] = React.useState("")

  const hits = React.useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const out: Hit[] = []
    for (const path of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
      if (path.toLowerCase().includes(q)) {
        out.push({ path })
        continue
      }
      const body = files[path]?.content ?? ""
      const idx = body.toLowerCase().indexOf(q)
      if (idx !== -1) {
        const start = Math.max(0, idx - 24)
        const snippet = body.slice(start, idx + q.length + 48).replace(/\s+/g, " ")
        out.push({ path, snippet })
      }
    }
    return out.slice(0, 80)
  }, [files, query])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-8 shrink-0 items-center border-b border-border/60 px-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        Buscar
      </header>
      <div className="shrink-0 p-2">
        <div className="relative">
          <FileSearch className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nombre de archivo o texto…"
            className="h-8 pl-8 text-[12.5px]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {query.trim() === "" ? (
          <p className="px-2 text-[12px] text-muted-foreground">Escribe para buscar en el workspace.</p>
        ) : hits.length === 0 ? (
          <p className="px-2 text-[12px] text-muted-foreground">Sin coincidencias.</p>
        ) : (
          <ul className="space-y-0.5">
            {hits.map((h) => (
              <li key={h.path}>
                <button
                  type="button"
                  className={cn(
                    "w-full rounded px-2 py-1.5 text-left text-[12px]",
                    "hover:bg-muted/70",
                  )}
                  onClick={() => openFile(h.path)}
                >
                  <div className="truncate font-mono text-foreground">{h.path}</div>
                  {h.snippet ? (
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{h.snippet}</div>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
