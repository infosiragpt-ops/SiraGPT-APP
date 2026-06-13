"use client"

// codex/checkpoint-card — "Checkpoint made X ago" (feature 11) with three real
// actions: Rollback here (explicit confirm → hard reset), Changes (diff modal),
// View preview (opens the live dev URL, starting it if needed). Relative time
// updates live.

import React, { useEffect, useState } from "react"
import { toast } from "sonner"
import { GitCommitHorizontal, History, FileDiff, Eye, Loader2, X } from "lucide-react"
import { codexApi, type CodexCheckpointDiff } from "@/lib/codex/codex-api"
import { relativeTime } from "@/lib/codex/format"

export interface CheckpointCardProps {
  checkpointId: string
  commitSha: string
  title: string
  createdAt?: string
  projectId?: string
  previewUrl?: string | null
  onRolledBack?: () => void
}

export function CheckpointCard({ checkpointId, commitSha, title, createdAt, projectId, previewUrl, onRolledBack }: CheckpointCardProps) {
  const [, setTick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [rolling, setRolling] = useState(false)
  const [diff, setDiff] = useState<CodexCheckpointDiff | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [opening, setOpening] = useState(false)

  // Live "made X ago".
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  async function doRollback() {
    setRolling(true)
    try {
      const r = await codexApi.rollbackCheckpoint(checkpointId)
      toast.success(`Rollback al checkpoint ${commitSha.slice(0, 7)}${r.restarted ? " (dev reiniciado)" : ""}`)
      setConfirming(false)
      onRolledBack?.()
    } catch (e: any) {
      toast.error(e?.message || "El rollback falló")
    } finally {
      setRolling(false)
    }
  }

  async function showDiff() {
    setLoadingDiff(true)
    try {
      setDiff(await codexApi.getCheckpointDiff(checkpointId))
    } catch (e: any) {
      toast.error(e?.message || "No se pudo cargar el diff")
    } finally {
      setLoadingDiff(false)
    }
  }

  async function viewPreview() {
    if (previewUrl) { window.open(previewUrl, "_blank", "noopener"); return }
    if (!projectId) return
    setOpening(true)
    try {
      const r = await codexApi.startPreview(projectId)
      if (r.devUrl) window.open(r.devUrl, "_blank", "noopener")
    } catch (e: any) {
      toast.error(e?.message || "No se pudo abrir el preview")
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="my-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2">
        <GitCommitHorizontal className="h-4 w-4 text-zinc-400" />
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        <code className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-400">{commitSha.slice(0, 7)}</code>
        {createdAt && <span className="ml-auto text-xs text-zinc-500">{relativeTime(createdAt)}</span>}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Action onClick={() => setConfirming(true)} icon={History} label="Rollback here" />
        <Action onClick={showDiff} icon={loadingDiff ? Loader2 : FileDiff} label="Changes" spin={loadingDiff} />
        <Action onClick={viewPreview} icon={opening ? Loader2 : Eye} label="View preview" spin={opening} />
      </div>

      {confirming && (
        <Modal onClose={() => setConfirming(false)} title="¿Hacer rollback a este checkpoint?">
          <p className="text-sm text-zinc-300">Se descartarán <strong>todos los cambios posteriores</strong> a este commit en el workspace. Esta acción no se puede deshacer.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setConfirming(false)} className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-zinc-300 hover:bg-white/5">Cancelar</button>
            <button onClick={doRollback} disabled={rolling} className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50">
              {rolling && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Hacer rollback
            </button>
          </div>
        </Modal>
      )}

      {diff && (
        <Modal onClose={() => setDiff(null)} title={`Cambios · +${diff.additions} −${diff.deletions} · ${diff.filesChanged} archivos`}>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-black/40 p-3 text-[11px] leading-relaxed">
            {diff.diff.split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "text-emerald-400" : line.startsWith("-") && !line.startsWith("---") ? "text-red-400" : line.startsWith("@@") ? "text-cyan-400" : "text-zinc-400"}>{line || " "}</div>
            ))}
          </pre>
          {diff.truncated && <p className="mt-1 text-xs text-amber-400">Diff truncado (muy largo).</p>}
        </Modal>
      )}
    </div>
  )
}

function Action({ onClick, icon: Icon, label, spin }: { onClick: () => void; icon: any; label: string; spin?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/5">
      <Icon className={`h-3.5 w-3.5 ${spin ? "animate-spin" : ""}`} /> {label}
    </button>
  )
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-zinc-900 p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
