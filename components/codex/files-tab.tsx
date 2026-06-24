"use client"

// codex/files-tab — read-only "Código" pane for the desktop 3-pane layout: a
// file list of the project's workspace (tracked + untracked source, no
// node_modules) on the left, the selected file's content on the right. Files
// are read through the runner (the only process with filesystem access).

import React, { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Folder, FileCode2, Loader2, RefreshCw } from "lucide-react"
import { codexApi } from "@/lib/codex/codex-api"

export function FilesTab({ projectId }: { projectId: string | null }) {
  const t = useTranslations("codex")
  const [files, setFiles] = useState<string[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const loadFiles = useCallback(async (keepSelection: boolean) => {
    if (!projectId) return
    setRefreshing(true)
    try {
      const list = await codexApi.listFiles(projectId)
      setFiles(list)
      setSelected((cur) => (keepSelection && cur && list.includes(cur) ? cur : list[0] ?? null))
    } catch {
      setFiles([])
    } finally {
      setRefreshing(false)
    }
  }, [projectId])

  useEffect(() => { setFiles(null); setSelected(null); setContent(null); void loadFiles(false) }, [loadFiles])

  useEffect(() => {
    if (!projectId || !selected) { setContent(null); return }
    let cancelled = false
    setLoadingFile(true)
    codexApi.readFileContent(projectId, selected)
      .then((r) => { if (!cancelled) setContent(r.content) })
      .catch(() => { if (!cancelled) setContent(null) })
      .finally(() => { if (!cancelled) setLoadingFile(false) })
    return () => { cancelled = true }
  }, [projectId, selected])

  if (!projectId) {
    return <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500"><Folder className="h-6 w-6 opacity-50" />{t("panel.emptySelect")}</div>
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-white/10">
        <div className="flex items-center justify-between border-b border-white/10 px-2 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{t("files.title")}</span>
          <button type="button" onClick={() => loadFiles(true)} disabled={refreshing} className="text-zinc-500 hover:text-zinc-200" aria-label={t("files.refresh")}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {files === null ? (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("files.loading")}</div>
          ) : files.length === 0 ? (
            <div className="px-2 py-2 text-xs text-zinc-500">{t("files.empty")}</div>
          ) : (
            files.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setSelected(f)}
                className={`flex w-full items-center gap-1.5 truncate px-2 py-1 text-left text-xs ${selected === f ? "bg-violet-500/15 text-violet-200" : "text-zinc-400 hover:bg-white/5"}`}
                title={f}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <span className="truncate">{f}</span>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-white/10 px-3 py-1.5 text-xs text-zinc-400">{selected || t("files.none")}</div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loadingFile ? (
            <div className="flex items-center gap-2 p-3 text-xs text-zinc-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t("files.loading")}</div>
          ) : content === null ? (
            <div className="p-3 text-xs text-zinc-500">{t("files.none")}</div>
          ) : (
            <pre className="whitespace-pre-wrap break-words p-3 text-[12px] leading-relaxed text-zinc-300">{content}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
