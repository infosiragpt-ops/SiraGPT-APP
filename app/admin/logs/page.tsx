"use client"

/**
 * Admin · Logs — auditoría operativa del sistema.
 *
 * The sidebar has linked /admin/logs since the panel shipped, but the page
 * never existed (the entry dead-ended on the Next 404). The backend
 * (/api/admin/audit-logs[.csv|/search]) and the apiClient methods were
 * already implemented and consumer-less — this page is the missing consumer.
 *
 * Operator affordances for tracking software errors (e.g. a failed image
 * generation): per-row selection checkboxes + one-click "copy selected",
 * a date-range filter, an "errors only" quick filter, and a live mode that
 * polls the feed in real time so new events appear at the top automatically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Copy, Download, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { apiClient } from "@/lib/api"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

type AuditLogRow = {
  id: string
  actorType?: string | null
  actorId?: string | null
  actorName?: string | null
  resourceType?: string | null
  resourceId?: string | null
  action: string
  metadata?: Record<string, unknown> | null
  createdAt: string
}

const PAGE_SIZE = 25
const LIVE_INTERVAL_MS = 5000

function isErrorAction(action: string): boolean {
  return /fail|error|denied|revoked|deleted|mismatch|expired|blocked|rejected|invalid/i.test(action)
}

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (isErrorAction(action)) return "destructive"
  if (/login|session|auth/i.test(action)) return "secondary"
  return "outline"
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es", { dateStyle: "short", timeStyle: "medium" })
  } catch {
    return iso
  }
}

function metadataSummary(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return ""
  const parts: string[] = []
  if (typeof metadata.reason === "string") parts.push(metadata.reason)
  if (typeof metadata.ip === "string") parts.push(String(metadata.ip))
  if (parts.length === 0) {
    const keys = Object.keys(metadata).slice(0, 3)
    if (keys.length) parts.push(keys.map((k) => `${k}=${String((metadata as any)[k]).slice(0, 24)}`).join(" · "))
  }
  return parts.join(" · ").slice(0, 90)
}

// Full, paste-ready detail for the clipboard export (no 90-char clamp).
function metadataFull(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || typeof metadata !== "object") return ""
  try {
    return JSON.stringify(metadata)
  } catch {
    return ""
  }
}

// Convert a <input type="date"> value (YYYY-MM-DD) into an inclusive ISO bound.
function dayBoundIso(date: string, end: boolean): string | undefined {
  if (!date) return undefined
  const suffix = end ? "T23:59:59.999" : "T00:00:00.000"
  const d = new Date(`${date}${suffix}`)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

export default function AdminLogsPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [searchTerm, setSearchTerm] = useState("")
  const [actionFilter, setActionFilter] = useState<string>("all")
  const [knownActions, setKnownActions] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [live, setLive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [detailRow, setDetailRow] = useState<AuditLogRow | null>(null)

  const load = useCallback(async (
    targetPage: number,
    search: string,
    action: string,
    from: string,
    to: string,
    opts?: { silent?: boolean },
  ) => {
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      const fromIso = dayBoundIso(from, false)
      const toIso = dayBoundIso(to, true)
      const common: Record<string, string | number> = { page: targetPage, limit: PAGE_SIZE, order: "desc" }
      if (fromIso) common.from = fromIso
      if (toIso) common.to = toIso
      const params: Record<string, string | number> = { ...common }
      if (action && action !== "all") params.action = action
      const response: any = search.trim()
        ? await apiClient.searchAdminAuditLogs({ q: search.trim(), ...common } as any)
        : await apiClient.getAdminAuditLogs(params as any)
      const items: AuditLogRow[] = response?.items || response?.logs || []
      setRows(items)
      setHasMore(items.length >= PAGE_SIZE)
      setLastUpdated(new Date().toLocaleTimeString("es", { timeStyle: "medium" }))
      setKnownActions((prev) => {
        const next = new Set(prev)
        items.forEach((row) => row.action && next.add(row.action))
        return Array.from(next).sort()
      })
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los logs")
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(page, searchTerm, actionFilter, fromDate, toDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, actionFilter, fromDate, toDate])

  // Live mode — poll the most-recent page on an interval so new events stream
  // in without a manual refresh. Only polls page 1 (the newest slice) and
  // pauses while paginating back through history.
  const liveRef = useRef({ searchTerm, actionFilter, fromDate, toDate })
  liveRef.current = { searchTerm, actionFilter, fromDate, toDate }
  useEffect(() => {
    if (!live || page !== 1) return
    const id = setInterval(() => {
      const s = liveRef.current
      void load(1, s.searchTerm, s.actionFilter, s.fromDate, s.toDate, { silent: true })
    }, LIVE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [live, page, load])

  // Rows actually shown (errors-only is a client-side view filter on top of
  // whatever the server returned for the current page).
  const visibleRows = useMemo(
    () => (errorsOnly ? rows.filter((r) => isErrorAction(r.action)) : rows),
    [rows, errorsOnly],
  )

  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id))
  const someSelected = selected.size > 0

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) visibleRows.forEach((r) => next.delete(r.id))
      else visibleRows.forEach((r) => next.add(r.id))
      return next
    })
  }

  const handleSearch = () => {
    setPage(1)
    void load(1, searchTerm, actionFilter, fromDate, toDate)
  }

  // Copy the selected rows (or every visible row when nothing is checked) as a
  // tab-separated block with a header — paste-ready for a ticket or spreadsheet.
  const handleCopy = async () => {
    const source = someSelected ? visibleRows.filter((r) => selected.has(r.id)) : visibleRows
    if (source.length === 0) {
      toast.error("No hay filas para copiar")
      return
    }
    const header = ["Fecha", "Acción", "Actor", "Recurso", "Detalle"].join("\t")
    const lines = source.map((r) => [
      formatTimestamp(r.createdAt),
      r.action,
      r.actorName || r.actorId || r.actorType || "—",
      [r.resourceType, r.resourceId].filter(Boolean).join(":") || "—",
      (metadataFull(r.metadata) || metadataSummary(r.metadata) || "—").replace(/\s+/g, " "),
    ].join("\t"))
    const text = [header, ...lines].join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${source.length} ${source.length === 1 ? "evento copiado" : "eventos copiados"} al portapapeles`)
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  // Pretty, paste-ready JSON for a single event — the full record including
  // untruncated metadata, so an operator can see exactly why something failed.
  const eventToJson = (row: AuditLogRow): string => {
    const payload = {
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      actor: { type: row.actorType ?? null, id: row.actorId ?? null, name: row.actorName ?? null },
      resource: { type: row.resourceType ?? null, id: row.resourceId ?? null },
      metadata: row.metadata ?? null,
    }
    try {
      return JSON.stringify(payload, null, 2)
    } catch {
      return String(payload)
    }
  }

  const copyDetail = async (row: AuditLogRow) => {
    try {
      await navigator.clipboard.writeText(eventToJson(row))
      toast.success("Evento copiado (JSON) al portapapeles")
    } catch {
      toast.error("No se pudo copiar al portapapeles")
    }
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const params: Record<string, string> = {}
      if (actionFilter && actionFilter !== "all") params.action = actionFilter
      const fromIso = dayBoundIso(fromDate, false)
      const toIso = dayBoundIso(toDate, true)
      if (fromIso) params.from = fromIso
      if (toIso) params.to = toIso
      const csv = await apiClient.exportAdminAuditLogsCsv(params as any)
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "audit-logs.csv"
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Logs exportados a CSV")
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar el CSV")
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Auditoría del sistema: sesiones, cambios de roles, acciones administrativas.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Registro de auditoría</CardTitle>
              <CardDescription>
                Eventos más recientes primero
                {lastUpdated ? ` · actualizado ${lastUpdated}` : ""}
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSearch() }}
                  placeholder="Buscar (usuario, recurso, texto)…"
                  className="w-56 pl-8"
                />
              </div>
              <Select value={actionFilter} onValueChange={(v) => { setActionFilter(v); setPage(1) }}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Acción" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las acciones</SelectItem>
                  {knownActions.map((action) => (
                    <SelectItem key={action} value={action}>{action}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void load(page, searchTerm, actionFilter, fromDate, toDate)} disabled={loading}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={exporting}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {exporting ? "Exportando…" : "Exportar CSV"}
              </Button>
            </div>
          </div>

          {/* Secondary toolbar — date range, errors-only, live, copy selected */}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Desde</span>
              <Input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => { setFromDate(e.target.value); setPage(1) }}
                className="h-8 w-[9.5rem] text-xs"
              />
              <span className="text-xs font-medium text-muted-foreground">Hasta</span>
              <Input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => { setToDate(e.target.value); setPage(1) }}
                className="h-8 w-[9.5rem] text-xs"
              />
              {(fromDate || toDate) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 text-xs text-muted-foreground"
                  onClick={() => { setFromDate(""); setToDate(""); setPage(1) }}
                >
                  Limpiar
                </Button>
              )}
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              <Switch checked={errorsOnly} onCheckedChange={(v) => setErrorsOnly(!!v)} />
              Solo errores
            </label>

            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
              <Switch checked={live} onCheckedChange={(v) => setLive(!!v)} />
              <span className="flex items-center gap-1.5">
                {live && (
                  <span
                    className="inline-block h-2 w-2 animate-pulse rounded-full"
                    style={{ backgroundColor: "#22c55e" }}
                    aria-hidden
                  />
                )}
                En vivo
              </span>
            </label>

            <div className="ml-auto flex items-center gap-2">
              {someSelected && (
                <span className="text-xs text-muted-foreground">{selected.size} seleccionados</span>
              )}
              <Button variant="outline" size="sm" onClick={() => void handleCopy()} disabled={visibleRows.length === 0}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {someSelected ? `Copiar (${selected.size})` : "Copiar todo"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive">
              {error}
            </div>
          ) : visibleRows.length === 0 && !loading ? (
            <div className="rounded-md border border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
              {errorsOnly ? "Sin errores para este filtro." : "Sin eventos para este filtro."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={toggleAllVisible}
                      aria-label="Seleccionar todos"
                    />
                  </TableHead>
                  <TableHead className="w-44">Fecha</TableHead>
                  <TableHead className="w-48">Acción</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  <TableHead className="w-36">Recurso</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  const isErr = isErrorAction(row.action)
                  const isChecked = selected.has(row.id)
                  return (
                    <TableRow
                      key={row.id}
                      data-state={isChecked ? "selected" : undefined}
                      className={cn("cursor-pointer", isErr && "bg-destructive/5")}
                      onClick={() => setDetailRow(row)}
                      title="Ver detalle del evento"
                    >
                      <TableCell className="align-middle" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={isChecked}
                          onCheckedChange={() => toggleRow(row.id)}
                          aria-label="Seleccionar evento"
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                        {formatTimestamp(row.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={actionBadgeVariant(row.action)} className="font-mono text-[11px]">
                          {row.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-40 truncate text-xs" title={row.actorId || undefined}>
                        {row.actorName || row.actorId || row.actorType || "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.resourceType || "—"}
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={metadataFull(row.metadata) || metadataSummary(row.metadata)}>
                        {metadataSummary(row.metadata) || "—"}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Página {page}{live && page === 1 ? " · en vivo" : ""}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={!hasMore || loading} onClick={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Event detail — full record with untruncated metadata for debugging. */}
      <Dialog open={!!detailRow} onOpenChange={(o) => { if (!o) setDetailRow(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>Detalle del evento</span>
              {detailRow && (
                <Badge variant={actionBadgeVariant(detailRow.action)} className="font-mono text-[11px]">
                  {detailRow.action}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              {detailRow ? formatTimestamp(detailRow.createdAt) : ""}
            </DialogDescription>
          </DialogHeader>
          {detailRow && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Actor</div>
                  <div className="break-all">{detailRow.actorName || detailRow.actorId || detailRow.actorType || "—"}</div>
                  {detailRow.actorId && detailRow.actorName && (
                    <div className="break-all text-xs text-muted-foreground">{detailRow.actorId}</div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-muted-foreground">Recurso</div>
                  <div className="break-all">{[detailRow.resourceType, detailRow.resourceId].filter(Boolean).join(" · ") || "—"}</div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="mb-1 text-xs font-medium text-muted-foreground">Metadata</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-3 text-xs leading-relaxed">
                  {detailRow.metadata ? JSON.stringify(detailRow.metadata, null, 2) : "—"}
                </pre>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => void copyDetail(detailRow)}>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copiar JSON
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
