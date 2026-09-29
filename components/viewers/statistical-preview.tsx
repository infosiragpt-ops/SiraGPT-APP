"use client"

import React from "react"
import { ThinkingIndicator } from "@/components/ui/thinking-indicator"
import { cn } from "@/lib/utils"
import { assertStatisticalPreview, statisticalCellText, type StatisticalPreview } from "@/lib/tabular-preview"

export function StatisticalDataPreview({ loadPage }: { loadPage: (offset: number) => Promise<unknown> }) {
  const [data, setData] = React.useState<StatisticalPreview | null>(null)
  const [offset, setOffset] = React.useState(0)
  const [tab, setTab] = React.useState<"data" | "variables">("data")
  const [labels, setLabels] = React.useState(false)
  const [error, setError] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [reload, setReload] = React.useState(0)
  React.useEffect(() => { setOffset(0); setData(null) }, [loadPage])
  React.useEffect(() => {
    let cancelled = false
    setLoading(true); setError("")
    void loadPage(offset).then((value) => {
      assertStatisticalPreview(value)
      if (!cancelled) setData(value)
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo abrir el archivo estadístico.") }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [offset, loadPage, reload])
  if (error) return <div role="alert" className="p-6 text-sm"><p>{error}</p><button onClick={() => setReload((value) => value + 1)} className="mt-3 rounded border px-3 py-2">Reintentar</button></div>
  if (!data) return <div role="status" className="flex h-full items-center justify-center gap-2 text-sm"><ThinkingIndicator size="sm" />Leyendo datos y variables…</div>
  return <div data-testid="statistical-preview" className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs">
      <div role="tablist" aria-label="Vistas SPSS" className="flex gap-1">{([ ["data", "Datos"], ["variables", "Variables"] ] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={cn("rounded px-3 py-1.5 font-medium", tab === value ? "bg-foreground text-background" : "text-muted-foreground")}>{label}</button>)}</div>
      <span>{data.rowCount == null ? "Casos" : `${data.rowCount} casos`} · {data.columnCount} variables</span>
      {tab === "data" && <label className="flex items-center gap-1.5"><input type="checkbox" checked={labels} onChange={(event) => setLabels(event.target.checked)} />Mostrar etiquetas</label>}
    </div>
    {(data.truncated.columns || data.truncated.values) && <p role="status" className="border-b px-3 py-1 text-xs text-muted-foreground">Vista acotada{data.truncated.columns ? ` a ${data.columns.length} variables` : ""}{data.truncated.values ? "; algunos textos o etiquetas se abrevian" : ""}. El archivo conserva todo el contenido.</p>}
    <div className="relative min-h-0 flex-1 overflow-auto">
      {loading && <div role="status" className="sticky left-0 top-0 z-30 flex items-center gap-2 bg-background/90 px-3 py-2 text-xs"><ThinkingIndicator size="sm" />Leyendo casos…</div>}
      <table aria-label={tab === "data" ? "Datos SPSS" : "Variables SPSS"} className="border-separate border-spacing-0 text-xs tabular-nums">
        <thead className="sticky top-0 z-20 bg-muted"><tr>{tab === "data" ? <><th className="sticky left-0 z-30 border-b border-r bg-muted px-3 py-2">Caso</th>{data.columns.map((column) => <th key={column.name} className="min-w-24 whitespace-nowrap border-b border-r px-3 py-2 text-left font-semibold" title={column.label || column.name}>{column.name}</th>)}</> : ["Nombre", "Tipo", "Etiqueta", "Valores", "Perdidos"].map((label) => <th key={label} className="border-b border-r px-3 py-2 text-left">{label}</th>)}</tr></thead>
        <tbody>{tab === "data" ? data.rows.map((row, r) => <tr key={data.offset + r} className="odd:bg-background even:bg-muted/25"><th scope="row" className="sticky left-0 z-10 border-b border-r bg-muted px-3 py-1.5 text-right font-normal">{data.offset + r + 1}</th>{row.map((value, c) => <td key={c} className="max-w-96 whitespace-pre-wrap border-b border-r px-3 py-1.5" title={value == null ? "Valor perdido" : String(value)}>{statisticalCellText(value, data.columns[c].valueLabels, labels)}</td>)}</tr>) : data.columns.map((column) => <tr key={column.name} className="odd:bg-background even:bg-muted/25"><th scope="row" className="border-b border-r px-3 py-2 text-left font-medium">{column.name}</th><td className="border-b border-r px-3 py-2">{column.type}</td><td className="min-w-52 border-b border-r px-3 py-2">{column.label || "—"}</td><td className="min-w-52 whitespace-pre-line border-b border-r px-3 py-2">{Object.entries(column.valueLabels || {}).map(([value, label]) => `${value} = ${label}`).join("\n") || "—"}</td><td className="border-b border-r px-3 py-2">{column.missingValues && Object.keys(column.missingValues).length ? JSON.stringify(column.missingValues) : "—"}</td></tr>)}</tbody>
      </table>
      {tab === "data" && !data.rows.length && <p className="p-4 text-sm text-muted-foreground">No hay casos en esta página.</p>}
    </div>
    <div className="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground"><span>Solo lectura · {data.format.toUpperCase()}</span>{tab === "data" && <div className="flex items-center gap-2"><button disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - data.limit))} className="rounded border px-2 py-1 disabled:opacity-40" aria-label="Casos anteriores">‹</button><span>{data.rows.length ? `${data.offset + 1}–${data.offset + data.rows.length}` : "0"}{data.rowCount != null ? ` de ${data.rowCount}` : ""}</span><button disabled={loading || !data.hasMore} onClick={() => setOffset(data.offset + data.rows.length)} className="rounded border px-2 py-1 disabled:opacity-40" aria-label="Casos siguientes">›</button></div>}</div>
  </div>
}
