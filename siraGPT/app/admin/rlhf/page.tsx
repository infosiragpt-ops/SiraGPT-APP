"use client"

/**
 * /admin/rlhf — phase 3 ops surface for the preference flywheel.
 * Read stats, backfill historical thumbs, train the in-process RM,
 * and launch an SFT/DPO fine-tune from the export (OpenAI if configured).
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RefreshCw, Download, Database, GraduationCap } from "lucide-react"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

type RlhfStats = {
  ok?: boolean
  enabled?: boolean
  steering?: boolean
  bestOfN?: boolean
  model?: { version?: number; trainedAt?: string; metrics?: Record<string, number> } | null
  global?: { total?: number; chosen?: number; rejected?: number; unlabeled?: number; pairs?: number } | null
  user?: { total?: number; chosen?: number; rejected?: number }
  phase2?: Record<string, unknown>
}

type FineTuneJob = {
  id: string
  format?: string
  status?: string
  createdAt?: string
  result?: { count?: number }
  error?: string | null
  [k: string]: unknown
}

function flag(v: boolean | undefined) {
  return v ? "on" : "off"
}

export default function AdminRlhfPage() {
  const [stats, setStats] = useState<RlhfStats | null>(null)
  const [jobs, setJobs] = useState<FineTuneJob[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, j] = await Promise.all([
        apiClient.getRlhfStats() as Promise<RlhfStats>,
        apiClient.getRlhfTrainJobs().catch(() => ({ jobs: [] })) as Promise<{ jobs?: FineTuneJob[] }>,
      ])
      setStats(s)
      setJobs(Array.isArray(j?.jobs) ? j.jobs : [])
    } catch (err: any) {
      setError(err?.message || "No se pudo cargar RLHF")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      const out = await fn() as { ok?: boolean; reason?: string; error?: string }
      if (out && out.ok === false) {
        toast.error(out.reason || out.error || "Operación rechazada")
      } else {
        toast.success("Listo")
      }
      await load()
    } catch (err: any) {
      toast.error(err?.message || "Falló la operación")
    } finally {
      setBusy(null)
    }
  }

  const g = stats?.global || {}

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">RLHF</h1>
          <p className="text-sm text-muted-foreground">
            Preferencias humanas, reward model y export SFT/DPO. Best-of-N sigue apagado.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Eventos</CardDescription><CardTitle>{g.total ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Chosen</CardDescription><CardTitle>{g.chosen ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Rejected</CardDescription><CardTitle>{g.rejected ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Pares DPO</CardDescription><CardTitle>{g.pairs ?? 0}</CardTitle></CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flags</CardTitle>
          <CardDescription>Recolección y steering en vivo. Best-of-N no se enciende por coste de tokens.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge variant="secondary">colección {flag(stats?.enabled)}</Badge>
          <Badge variant="secondary">steering {flag(stats?.steering)}</Badge>
          <Badge variant="secondary">best-of-n {flag(stats?.bestOfN)}</Badge>
          <Badge variant={stats?.model ? "default" : "outline"}>
            RM {stats?.model ? `v${stats.model.version}` : "sin entrenar"}
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Acciones</CardTitle>
          <CardDescription>Backfill de thumbs históricos, entrenamiento del RM y fine-tune externo.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => run("backfill", () => apiClient.postRlhfBackfill())}
          >
            <Database className="mr-2 h-4 w-4" />
            {busy === "backfill" ? "Copiando…" : "Backfill thumbs"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => run("train", () => apiClient.postRlhfTrain())}
          >
            <GraduationCap className="mr-2 h-4 w-4" />
            {busy === "train" ? "Entrenando…" : "Entrenar RM"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => run("sft", () => apiClient.postRlhfTrainJob("sft"))}
          >
            Preparar SFT
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => run("dpo", () => apiClient.postRlhfTrainJob("dpo"))}
          >
            Preparar DPO
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href="/api/rlhf/export?format=sft&scope=global" target="_blank" rel="noreferrer">
              <Download className="mr-2 h-4 w-4" /> SFT JSONL
            </a>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href="/api/rlhf/export?format=dpo&scope=global" target="_blank" rel="noreferrer">
              <Download className="mr-2 h-4 w-4" /> DPO JSONL
            </a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fine-tunes recientes</CardTitle>
          <CardDescription>
            Jobs de prep (`SIRAGPT_RLHF_TRAIN_JOBS=1`). El JSONL se guarda como artefacto; no hay auto-train de pago.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no hay jobs. Hace falta un mínimo de ejemplos (8 SFT / 4 pares DPO).</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {jobs.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-2">
                  <Badge variant="outline">{job.format || "job"}</Badge>
                  <span>{job.status || "—"}</span>
                  {job.result?.count != null && (
                    <span className="text-muted-foreground">{job.result.count} filas</span>
                  )}
                  {job.error ? <span className="text-destructive">{String(job.error)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
