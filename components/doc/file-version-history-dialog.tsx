"use client"

import * as React from "react"
import { CheckCircle2, Download, History, Loader2, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import apiClient, { type FileVersionRecord } from "@/lib/api"
import { downloadUrlAsFile } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function FileVersionHistoryDialog({
  fileId,
  open,
  onOpenChange,
}: {
  fileId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [versions, setVersions] = React.useState<FileVersionRecord[]>([])
  const [loading, setLoading] = React.useState(false)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const result = await apiClient.getFileVersions(fileId)
      setVersions(result.versions || [])
    } catch (error: any) {
      toast.error(error?.message || "No se pudo cargar el historial")
    } finally {
      setLoading(false)
    }
  }, [fileId])

  React.useEffect(() => {
    if (open) void load()
  }, [load, open])

  const restore = async (version: FileVersionRecord) => {
    setRestoringId(version.id)
    try {
      const result = await apiClient.restoreFileVersion(fileId, version.id)
      toast.success(`Versión ${version.version} restaurada como versión ${result.version.version}`)
      await load()
    } catch (error: any) {
      toast.error(error?.message || "No se pudo restaurar la versión")
    } finally {
      setRestoringId(null)
    }
  }

  const download = async (version: FileVersionRecord) => {
    if (!version.downloadUrl) return
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("auth-token") : null
      await downloadUrlAsFile(version.downloadUrl, version.filename, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
    } catch {
      toast.error("No se pudo descargar esta versión")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Historial del documento
          </DialogTitle>
          <DialogDescription>
            Restaurar crea una versión nueva. El archivo original y las ediciones anteriores se conservan.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : versions.length === 0 ? (
          <div className="border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            Aún no hay ediciones versionadas para este archivo.
          </div>
        ) : (
          <div className="max-h-[55vh] divide-y divide-border overflow-auto border border-border">
            {versions.map((version, index) => (
              <div key={version.id} className="flex items-start gap-3 p-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                  v{version.version}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="truncate">{version.filename}</span>
                    {index === 0 && <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">Actual</span>}
                    {version.validationPassed && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-label="Validada" />}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {version.summary || "Edición guardada"} · {new Date(version.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {version.downloadUrl && (
                    <Button size="icon" variant="ghost" onClick={() => void download(version)} aria-label={`Descargar versión ${version.version}`} title="Descargar">
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => void restore(version)}
                    disabled={restoringId !== null}
                    aria-label={`Restaurar versión ${version.version}`}
                    title="Restaurar como nueva versión"
                  >
                    {restoringId === version.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
