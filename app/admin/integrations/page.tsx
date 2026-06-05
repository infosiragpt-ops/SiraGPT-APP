"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, Layers3, PackageSearch, RefreshCw, Workflow } from "lucide-react"
import { apiClient } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

type Snapshot = {
  integrations?: any
  readiness?: any
  parsers?: any[]
  generators?: any[]
}

const READINESS_REQUEST = {
  primaryIntent: "professional_document_generation",
  secondaryIntents: ["scientific_research", "doi_validation", "data_analysis"],
  outputFormats: ["md", "docx", "pdf", "xlsx", "pptx", "svg"],
  requiredTools: [
    "citation_formatter",
    "latex_renderer",
    "docx_renderer",
    "pdf_renderer",
    "spreadsheet_reader",
    "chart_generator",
    "web_search",
  ],
  requiresResearch: true,
  requiresFileProcessing: true,
  requiresVisual: true,
}

function badgeVariant(status: string | undefined): "default" | "secondary" | "destructive" {
  const value = String(status || "").toLowerCase()
  if (["ready", "configured", "bound", "package_ready", "package_ready_stub_adapter"].includes(value)) return "default"
  if (["partial", "reference_only", "external_required", "stub_runtime_requires_binding"].includes(value)) return "secondary"
  return "destructive"
}

function n(value: unknown): string {
  const num = Number(value || 0)
  return Number.isFinite(num) ? num.toLocaleString() : "0"
}

export default function AdminIntegrationsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [integrations, readinessEnvelope, parserEnvelope, generatorEnvelope] = await Promise.all([
        apiClient.getProductOsIntegrations(),
        apiClient.getProductOsIntegrationsReadiness(READINESS_REQUEST),
        apiClient.getSiraParsers(),
        apiClient.getSiraGenerators(),
      ])
      setSnapshot({
        integrations,
        readiness: (readinessEnvelope as any)?.readiness || readinessEnvelope,
        parsers: (parserEnvelope as any)?.parsers || [],
        generators: (generatorEnvelope as any)?.generators || [],
      })
      setLastRefresh(new Date())
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar las integraciones.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const integrity = snapshot.integrations?.integrity
  const readiness = snapshot.readiness
  const inventory = readiness?.package_inventory || {}
  const layers = readiness?.layers || []
  const blockers = readiness?.blockers || []
  const families = inventory.high_impact_families || []

  const topFamilies = useMemo(
    () => families
      .slice()
      .sort((a: any, b: any) => Number(b.package_count || b.count || 0) - Number(a.package_count || a.count || 0))
      .slice(0, 10),
    [families],
  )
  const topParsers = useMemo(
    () => (snapshot.parsers || []).slice().sort((a: any, b: any) => Number(b.preference || 0) - Number(a.preference || 0)).slice(0, 12),
    [snapshot.parsers],
  )
  const topGenerators = useMemo(
    () => (snapshot.generators || []).slice().sort((a: any, b: any) => Number(b.preference || 0) - Number(a.preference || 0)).slice(0, 12),
    [snapshot.generators],
  )

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Integraciones Product OS</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Capas, librerías, conectores y readiness operativo del runtime agentic.
            {lastRefresh ? ` Última actualización: ${lastRefresh.toLocaleTimeString()}` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Recargar
        </Button>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-center gap-3 py-5 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={Layers3} label="Capas" value={n(integrity?.layer_count)} detail={`${n(integrity?.library_count)} librerías mapeadas`} />
        <MetricCard icon={PackageSearch} label="Lockfile" value={n(inventory.lock_package_count)} detail={`${n(inventory.expanded_library_catalog_count)} catalogadas`} />
        <MetricCard icon={Workflow} label="Familias" value={n(inventory.high_impact_family_count)} detail="alto impacto detectadas" />
        <MetricCard icon={CheckCircle2} label="Release" value={readiness?.release_gate?.ready_for_wet_run ? "Wet-run" : "Dry-run"} detail={`${n(blockers.length)} blocker(s)`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Readiness por capa</CardTitle>
            <CardDescription>Estado del lote amplio: documentos, investigación, data, visual y runtime.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Capa</th>
                    <th className="py-2 pr-4">Estado</th>
                    <th className="py-2 pr-4">Ready</th>
                    <th className="py-2 pr-4">Faltan</th>
                    <th className="py-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {layers.map((layer: any) => (
                    <tr key={layer.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">{layer.id}</td>
                      <td className="py-2 pr-4">
                        <Badge variant={badgeVariant(layer.operational_status)}>{layer.operational_status}</Badge>
                      </td>
                      <td className="py-2 pr-4">{n(layer.ready_libraries)}</td>
                      <td className="py-2 pr-4">{n(layer.missing_libraries + layer.external_required + layer.partial_libraries)}</td>
                      <td className="py-2">{Math.round(Number(layer.readiness_score || 0) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Familias de alto impacto</CardTitle>
            <CardDescription>Resumen del catálogo expandido detectado desde package manifests y lockfiles.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {topFamilies.map((family: any) => (
              <div key={family.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{family.label}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {(family.examples || family.sample || []).slice(0, 4).join(", ")}
                  </div>
                </div>
                <Badge variant="secondary">{n(family.package_count || family.count)}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <ListCard title="Blockers" description="Capas que requieren binding, paquete, env o runtime externo." rows={blockers.map((b: any) => ({
          id: b.layer_id,
          meta: b.reason,
          detail: (b.missing_libraries || []).join(", ") || "Sin detalle",
        }))} />
        <ListCard title="Parsers prioritarios" description="Selección documental por preferencia." rows={topParsers.map((p: any) => ({
          id: p.id,
          meta: `${p.language}/${p.runtime}`,
          detail: (p.formats || []).join(", "),
        }))} />
        <ListCard title="Generators prioritarios" description="Formatos de salida y runtimes." rows={topGenerators.map((g: any) => ({
          id: g.id,
          meta: `${g.format} · ${g.language}`,
          detail: g.mime || g.runtime || "sin mime",
        }))} />
      </div>
    </div>
  )
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: any; label: string; value: string; detail: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
          <div className="truncate text-2xl font-semibold tracking-tight">{value}</div>
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function ListCard({ title, description, rows }: { title: string; description: string; rows: Array<{ id: string; meta: string; detail: string }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin elementos.</p>
        ) : rows.map((row) => (
          <div key={`${title}-${row.id}`} className="rounded-md border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm">{row.id}</span>
              <Badge variant="secondary">{row.meta}</Badge>
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">{row.detail}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
