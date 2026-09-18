"use client"

/**
 * /admin/rlcd — calibrated decisions (RLCD) ops surface.
 * Reliability per decision kind (ECE / Brier / accuracy), reliability
 * diagrams, outcome mix, effective thresholds and flags, Jev status,
 * persistence status and the recent-decisions ring.
 */

import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RefreshCw, Save } from "lucide-react"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

type Bin = { range: [number, number]; samples: number; accuracy: number | null; avgConfidence: number | null; gap: number | null }
type Reliability = { kind: string; samples: number; ece: number | null; brier: number | null; accuracy: number | null; bins?: Bin[] }
type ConfigEntry = { value: number | boolean; default: number | boolean; env: string; doc: string; overridden: boolean }
type KindDoc = { label: string; decides: string; outcomes: string; deciders: string[] }
type RlcdStats = {
  ok?: boolean
  enabled?: boolean
  decisions?: number
  outcomes?: number
  outcomesUnmatched?: number
  pending?: number
  kinds?: string[]
  byKind?: Record<string, number>
  byOutcome?: Record<string, number>
  lane?: { consulted?: number; forced?: number }
  reliability?: Reliability[]
  reliabilityBins?: Reliability[]
  config?: {
    kinds: Record<string, KindDoc>
    thresholds: Record<string, ConfigEntry>
    flags: Record<string, ConfigEntry>
    jev: { configured: boolean; model: string; timeoutMs: number }
    persistence: { intervalMs: number; key: string }
  }
  persistence?: { enabled: boolean; started: boolean; restored: boolean; restoredDecisions: number; saves: number; lastSaveAt: number | null; lastError: string | null; dirty: boolean }
}
type Decision = {
  id: string
  kind: string
  choice: string | null
  confidence: number
  signature: string | null
  chatId: string | null
  source: string
  createdAt: number
  outcome: { label: string; value: number; source: string | null; at: number } | null
}

function pct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v * 100)} %`
}
function num(v: number | null | undefined, d = 3) {
  return v == null ? "—" : v.toFixed(d)
}
function ago(ts: number | null | undefined) {
  if (!ts) return "—"
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `hace ${s} s`
  if (s < 3600) return `hace ${Math.round(s / 60)} min`
  return `hace ${Math.round(s / 3600)} h`
}

export default function AdminRlcdPage() {
  const [stats, setStats] = useState<RlcdStats | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [kindFilter, setKindFilter] = useState<string>("")
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, d] = await Promise.all([
        apiClient.getRlcdStats() as Promise<RlcdStats>,
        apiClient.getRlcdDecisions({ limit: 60, kind: kindFilter || undefined }).catch(() => ({ decisions: [] })) as Promise<{ decisions?: Decision[] }>,
      ])
      setStats(s)
      setDecisions(Array.isArray(d?.decisions) ? d.decisions : [])
    } catch (err: any) {
      setError(err?.message || "No se pudo cargar RLCD")
    } finally {
      setLoading(false)
    }
  }, [kindFilter])

  useEffect(() => { load() }, [load])

  const persist = async () => {
    setBusy(true)
    try {
      const r = (await apiClient.postRlcdPersist()) as { ok?: boolean; reason?: string; error?: string }
      if (r?.ok) toast.success(`Ledger guardado (${r.reason})`)
      else toast.error(r?.error || r?.reason || "No se pudo guardar")
      await load()
    } catch (err: any) {
      toast.error(err?.message || "No se pudo guardar")
    } finally {
      setBusy(false)
    }
  }

  const reliability = stats?.reliabilityBins || stats?.reliability || []
  const kinds = stats?.kinds || reliability.map((r) => r.kind)
  const cfg = stats?.config
  const persistence = stats?.persistence

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">RLCD</h1>
          <p className="text-sm text-muted-foreground">
            Decisiones tipadas con probabilidad calibrada: fiabilidad por tipo, umbrales efectivos, Jev y persistencia.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={persist} disabled={busy || loading}>
            <Save className="mr-2 h-4 w-4" />
            {busy ? "Guardando…" : "Guardar ledger"}
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Actualizar
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Decisiones</CardDescription><CardTitle>{stats?.decisions ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Resultados unidos</CardDescription><CardTitle>{stats?.outcomes ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Sin decisión asociada</CardDescription><CardTitle>{stats?.outcomesUnmatched ?? 0}</CardTitle></CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Pendientes en memoria</CardDescription><CardTitle>{stats?.pending ?? 0}</CardTitle></CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Estado</CardTitle>
          <CardDescription>Flags efectivos, decisor Jev y persistencia del ledger en system_settings.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {cfg && Object.entries(cfg.flags).map(([k, f]) => (
            <Badge key={k} variant={f.value ? "default" : "outline"} title={`${f.env} — ${f.doc}`}>
              {k} {f.value ? "on" : "off"}{f.overridden ? " ·env" : ""}
            </Badge>
          ))}
          {cfg && (
            <Badge variant={cfg.jev.configured ? "default" : "outline"} title={`modelo ${cfg.jev.model}, timeout ${cfg.jev.timeoutMs} ms`}>
              Jev {cfg.jev.configured ? cfg.jev.model : "sin clave"}
            </Badge>
          )}
          {persistence && (
            <Badge variant={persistence.lastError ? "destructive" : persistence.saves > 0 || persistence.restored ? "default" : "secondary"} title={persistence.lastError || ""}>
              persistencia {persistence.restored ? `restaurada (${persistence.restoredDecisions})` : "sin restaurar"} · {persistence.saves} guardados · {ago(persistence.lastSaveAt)}{persistence.dirty ? " · cambios sin guardar" : ""}
            </Badge>
          )}
          {stats?.lane && (
            <Badge variant="secondary">carril consultado {stats.lane.consulted ?? 0} · forzado {stats.lane.forced ?? 0}</Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Fiabilidad por tipo de decisión</CardTitle>
          <CardDescription>ECE y Brier bajos = la confianza declarada coincide con lo observado. Sin muestras no hay calibración: se usa la confianza bruta.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">Tipo</th>
                  <th className="py-1 pr-3">Decide</th>
                  <th className="py-1 pr-3">Decisores</th>
                  <th className="py-1 pr-3 text-right">Decisiones</th>
                  <th className="py-1 pr-3 text-right">Con resultado</th>
                  <th className="py-1 pr-3 text-right">Acierto</th>
                  <th className="py-1 pr-3 text-right">ECE</th>
                  <th className="py-1 pr-3 text-right">Brier</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((k) => {
                  const r = reliability.find((x) => x.kind === k)
                  const doc = cfg?.kinds?.[k]
                  return (
                    <tr key={k} className="border-t border-border/40">
                      <td className="py-1 pr-3 font-medium">{doc?.label || k}<div className="text-xs text-muted-foreground">{k}</div></td>
                      <td className="py-1 pr-3 text-muted-foreground">{doc?.decides || "—"}</td>
                      <td className="py-1 pr-3">{(doc?.deciders || []).map((d) => <Badge key={d} variant="outline" className="mr-1">{d}</Badge>)}</td>
                      <td className="py-1 pr-3 text-right">{stats?.byKind?.[k] ?? 0}</td>
                      <td className="py-1 pr-3 text-right">{r?.samples ?? 0}</td>
                      <td className="py-1 pr-3 text-right">{pct(r?.accuracy)}</td>
                      <td className="py-1 pr-3 text-right">{num(r?.ece)}</td>
                      <td className="py-1 pr-3 text-right">{num(r?.brier)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {reliability.filter((r) => r.samples > 0 && Array.isArray(r.bins)).map((r) => (
              <div key={r.kind} className="rounded-md border border-border/40 p-3">
                <div className="mb-2 text-sm font-medium">{cfg?.kinds?.[r.kind]?.label || r.kind} · diagrama de fiabilidad</div>
                <div className="flex h-24 items-end gap-1">
                  {(r.bins || []).map((b, i) => (
                    <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${pct(b.range[0])}–${pct(b.range[1])}: ${b.samples} muestras, acierto ${pct(b.accuracy)}, confianza media ${pct(b.avgConfidence)}`}>
                      <div className="w-full rounded-t bg-primary/70" style={{ height: `${Math.round((b.accuracy ?? 0) * 100)}%`, minHeight: b.samples ? 2 : 0 }} />
                      <div className="mt-1 text-[10px] text-muted-foreground">{b.samples || ""}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-[10px] text-muted-foreground"><span>confianza 0</span><span>1</span></div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Umbrales</CardTitle>
            <CardDescription>Valor efectivo · por defecto · variable de entorno.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {cfg && Object.entries(cfg.thresholds).map(([k, t]) => (
                <li key={k} className="border-b border-border/40 pb-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{k}</span>
                    <span>{String(t.value)} <span className="text-muted-foreground">· def {String(t.default)}</span>{t.overridden && <Badge variant="outline" className="ml-2">env</Badge>}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{t.doc} <code>{t.env}</code></div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Resultados por etiqueta</CardTitle>
            <CardDescription>Señales que puntúan las decisiones (pulgares, regenerar, herramientas, proveedor).</CardDescription>
          </CardHeader>
          <CardContent>
            {stats?.byOutcome && Object.keys(stats.byOutcome).length ? (
              <ul className="space-y-1 text-sm">
                {Object.entries(stats.byOutcome).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <li key={k} className="flex justify-between border-b border-border/40 pb-1"><span>{k}</span><span>{v}</span></li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Aún no hay resultados unidos a decisiones.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Decisiones recientes</CardTitle>
              <CardDescription>Últimas decisiones en memoria con su resultado. `jev` = re-decidida por TypeSafe.</CardDescription>
            </div>
            <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="">todos los tipos</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {decisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin decisiones todavía.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3">Cuándo</th>
                    <th className="py-1 pr-3">Tipo</th>
                    <th className="py-1 pr-3">Elección</th>
                    <th className="py-1 pr-3 text-right">Confianza</th>
                    <th className="py-1 pr-3">Decisor</th>
                    <th className="py-1 pr-3">Resultado</th>
                    <th className="py-1 pr-3">Firma</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d) => (
                    <tr key={d.id} className="border-t border-border/40">
                      <td className="py-1 pr-3 whitespace-nowrap">{ago(d.createdAt)}</td>
                      <td className="py-1 pr-3">{d.kind}</td>
                      <td className="py-1 pr-3">{d.choice || "—"}</td>
                      <td className="py-1 pr-3 text-right">{pct(d.confidence)}</td>
                      <td className="py-1 pr-3"><Badge variant={d.source === "jev" ? "default" : "outline"}>{d.source}</Badge></td>
                      <td className="py-1 pr-3">
                        {d.outcome ? (
                          <Badge variant={d.outcome.value >= 0.5 ? "default" : "destructive"}>{d.outcome.label}{d.outcome.source ? ` · ${d.outcome.source}` : ""}</Badge>
                        ) : <span className="text-muted-foreground">pendiente</span>}
                      </td>
                      <td className="py-1 pr-3 text-xs text-muted-foreground">{d.signature || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
