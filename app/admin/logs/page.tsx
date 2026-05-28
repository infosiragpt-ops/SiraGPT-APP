"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  FileJson,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  TerminalSquare,
} from "lucide-react"
import { toast } from "sonner"

import { SidebarTrigger } from "@/components/ui/sidebar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiClient } from "@/lib/api"
import { cn } from "@/lib/utils"

type Granularity = "hour" | "day" | "month"
type TimePreset = "1h" | "24h" | "7d" | "30d" | "custom" | "all"
type SortOrder = "desc" | "asc"

type AuditRow = {
  id: string
  actorType?: string
  actorId?: string | null
  actorName?: string | null
  resourceType?: string
  resourceId?: string | null
  action: string
  metadata?: Record<string, any> | null
  createdAt: string
}

type AuditResponse = {
  items: AuditRow[]
  total: number
  page: number
  pages: number
  limit: number
  error?: string
}

const FILTERS = [
  { value: "observability", label: "Observabilidad" },
  { value: "client-error", label: "Frontend" },
  { value: "api-error", label: "API" },
  { value: "server-error", label: "Servidor" },
  { value: "user-facing-error", label: "4xx visibles" },
  { value: "security", label: "Seguridad" },
  { value: "all", label: "Todo" },
]

const TIME_PRESETS: Array<{ value: TimePreset; label: string }> = [
  { value: "1h", label: "Última hora" },
  { value: "24h", label: "24 horas" },
  { value: "7d", label: "7 días" },
  { value: "30d", label: "30 días" },
  { value: "custom", label: "Rango manual" },
  { value: "all", label: "Todo" },
]

const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: "hour", label: "Por horas" },
  { value: "day", label: "Por días" },
  { value: "month", label: "Por meses" },
]

function formatDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "-"
  return new Intl.DateTimeFormat("es-BO", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}

function isoDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ""
  return date.toISOString()
}

function normalizeInputDate(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toISOString()
}

function rangeFromPreset(preset: TimePreset, customFrom: string, customTo: string) {
  if (preset === "all") return {}
  if (preset === "custom") {
    return {
      from: normalizeInputDate(customFrom),
      to: normalizeInputDate(customTo),
    }
  }

  const now = Date.now()
  const hours = preset === "1h" ? 1 : preset === "24h" ? 24 : preset === "7d" ? 24 * 7 : 24 * 30
  return {
    from: new Date(now - hours * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  }
}

function rowSeverity(row: AuditRow): "error" | "warn" | "info" {
  const tags = Array.isArray(row.metadata?.tags) ? row.metadata.tags.join(" ") : ""
  const severity = String(row.metadata?.severity || "").toLowerCase()
  if (severity === "fatal" || severity === "error" || tags.includes("server-error")) return "error"
  if (severity === "warn" || tags.includes("user-facing-error")) return "warn"
  return "info"
}

function severityBadge(row: AuditRow) {
  const severity = rowSeverity(row)
  if (severity === "error") return <Badge variant="destructive">Error</Badge>
  if (severity === "warn") return <Badge variant="secondary">Advertencia</Badge>
  return <Badge variant="outline">Info</Badge>
}

function getRequestId(row: AuditRow): string {
  return String(row.metadata?.requestId || row.metadata?.request_id || row.metadata?.reqId || "")
}

function getEndpoint(row: AuditRow): string {
  return String(row.metadata?.endpoint || row.metadata?.page || row.metadata?.path || row.metadata?.route || "")
}

function compactMetadata(metadata: AuditRow["metadata"]): string {
  if (!metadata) return "Sin metadata"
  const message = metadata.message || metadata.reason || metadata.error || metadata.status || null
  const endpoint = metadata.endpoint || metadata.page || metadata.path || null
  const requestId = metadata.requestId || metadata.request_id || metadata.reqId || null
  return [message, endpoint, requestId ? `req:${requestId}` : null].filter(Boolean).join(" · ") || "Metadata registrada"
}

function bucketLabel(value: string, granularity: Granularity): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Sin fecha"
  if (granularity === "month") {
    return new Intl.DateTimeFormat("es-BO", { month: "long", year: "numeric" }).format(date)
  }
  if (granularity === "day") {
    return new Intl.DateTimeFormat("es-BO", { dateStyle: "full" }).format(date)
  }
  const hourBucket = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours())
  return new Intl.DateTimeFormat("es-BO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(hourBucket)
}

function triageLine(row: AuditRow): string {
  const severity = rowSeverity(row).toUpperCase()
  const requestId = getRequestId(row) || "sin-request-id"
  const endpoint = getEndpoint(row) || row.resourceType || "-"
  const user = row.actorName || row.actorId || "anon"
  return [
    isoDate(row.createdAt),
    severity,
    row.action,
    `usuario=${user}`,
    `ruta=${endpoint}`,
    `request=${requestId}`,
    compactMetadata(row.metadata),
  ].filter(Boolean).join(" | ")
}

function toJson(rows: AuditRow[]): string {
  return JSON.stringify(rows, null, 2)
}

function copyableDates(rows: AuditRow[], granularity: Granularity): string {
  return rows
    .map((row) => `${isoDate(row.createdAt)} | ${bucketLabel(row.createdAt, granularity)} | ${row.action} | ${getRequestId(row) || "sin-request-id"}`)
    .join("\n")
}

async function copyText(text: string, label: string) {
  if (!text.trim()) {
    toast.error("No hay datos para copiar")
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copiado`)
  } catch {
    toast.error("No se pudo copiar")
  }
}

export default function AdminLogsPage() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [filter, setFilter] = useState("observability")
  const [search, setSearch] = useState("")
  const [timePreset, setTimePreset] = useState<TimePreset>("24h")
  const [granularity, setGranularity] = useState<Granularity>("hour")
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AuditRow | null>(null)

  const timeWindow = useMemo(
    () => rangeFromPreset(timePreset, customFrom, customTo),
    [customFrom, customTo, timePreset],
  )

  const load = useCallback(async (nextPage = 1) => {
    setLoading(true)
    setError(null)
    try {
      const trimmed = search.trim()
      const commonParams = {
        page: nextPage,
        limit: 50,
        tags: filter === "all" ? undefined : filter,
        from: timeWindow.from,
        to: timeWindow.to,
        order: sortOrder,
      }
      const result = trimmed.length >= 2
        ? await apiClient.searchAdminAuditLogs({ q: trimmed, ...commonParams })
        : await apiClient.getAdminAuditLogs(commonParams)
      const data = result as AuditResponse
      setRows(Array.isArray(data.items) ? data.items : [])
      setTotal(Number(data.total || 0))
      setPage(Number(data.page || nextPage))
      setPages(Number(data.pages || 1))
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los logs")
      setRows([])
      setTotal(0)
      setPages(1)
    } finally {
      setLoading(false)
    }
  }, [filter, search, sortOrder, timeWindow.from, timeWindow.to])

  useEffect(() => {
    const id = setTimeout(() => load(1), 250)
    return () => clearTimeout(id)
  }, [load])

  const stats = useMemo(() => {
    const errors = rows.filter((row) => rowSeverity(row) === "error").length
    const warnings = rows.filter((row) => rowSeverity(row) === "warn").length
    const api = rows.filter((row) => row.metadata?.source === "api" || row.action.includes("api")).length
    const requests = new Set(rows.map(getRequestId).filter(Boolean)).size
    return { errors, warnings, api, requests, total: rows.length }
  }, [rows])

  const buckets = useMemo(() => {
    const map = new Map<string, { label: string; rows: AuditRow[]; errors: number; warnings: number }>()
    for (const row of rows) {
      const label = bucketLabel(row.createdAt, granularity)
      const current = map.get(label) || { label, rows: [], errors: 0, warnings: 0 }
      current.rows.push(row)
      const severity = rowSeverity(row)
      if (severity === "error") current.errors += 1
      if (severity === "warn") current.warnings += 1
      map.set(label, current)
    }
    return Array.from(map.values())
  }, [granularity, rows])

  const visibleTriage = useMemo(() => rows.map(triageLine).join("\n"), [rows])

  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      const csv = await apiClient.exportAdminAuditLogsCsv({
        tags: filter === "all" ? undefined : filter,
        from: timeWindow.from,
        to: timeWindow.to,
        order: sortOrder,
        limit: 500,
      })
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `siragpt-logs-${Date.now()}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
      toast.success("CSV exportado")
    } catch (err: any) {
      toast.error(err?.message || "No se pudo exportar CSV")
    } finally {
      setExporting(false)
    }
  }, [filter, sortOrder, timeWindow.from, timeWindow.to])

  return (
    <div className="min-w-0 max-w-full flex-1 space-y-4 overflow-x-hidden p-3 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:space-y-5 sm:p-4 lg:p-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-start gap-2 sm:gap-3">
            <SidebarTrigger className="mt-1 md:hidden" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Logs</h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Rastreo de fallas por usuario, acción, ruta, fecha y request id.
              </p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
          <Button variant="outline" size="sm" onClick={() => copyText(copyableDates(rows, granularity), "Fechas")} disabled={loading || rows.length === 0} className="gap-2">
            <CalendarClock className="h-4 w-4" />
            Fechas
          </Button>
          <Button variant="outline" size="sm" onClick={() => copyText(visibleTriage, "Logs visibles")} disabled={loading || rows.length === 0} className="gap-2">
            <Copy className="h-4 w-4" />
            Copiar
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting} className="gap-2">
            <Download className={cn("h-4 w-4", exporting && "animate-pulse")} />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => load(page)} disabled={loading} className="gap-2">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Recargar
          </Button>
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="min-w-0">
          <CardHeader className="p-3 sm:p-4">
            <CardDescription>Visibles</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><TerminalSquare className="h-5 w-5 text-sky-500" />{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="p-3 sm:p-4">
            <CardDescription>Críticos</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><ShieldAlert className="h-5 w-5 text-red-500" />{stats.errors}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="p-3 sm:p-4">
            <CardDescription>Advertencias</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><AlertTriangle className="h-5 w-5 text-amber-500" />{stats.warnings}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="p-3 sm:p-4">
            <CardDescription>Fallos API</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><Clock3 className="h-5 w-5 text-violet-500" />{stats.api}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="min-w-0 col-span-2 lg:col-span-1">
          <CardHeader className="p-3 sm:p-4">
            <CardDescription>Request ids</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><Filter className="h-5 w-5 text-emerald-500" />{stats.requests}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader className="px-3 py-4 sm:px-6">
          <CardTitle>Investigación</CardTitle>
          <CardDescription>
            Filtra por tipo, rango temporal y texto. Los datos sensibles se redactan antes de guardarse.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-3 sm:px-6">
          <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[180px_160px_160px_140px_1fr]">
            <Select value={filter} onValueChange={(value) => { setFilter(value); setPage(1) }}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                {FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={timePreset} onValueChange={(value) => { setTimePreset(value as TimePreset); setPage(1) }}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Rango" />
              </SelectTrigger>
              <SelectContent>
                {TIME_PRESETS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={granularity} onValueChange={(value) => setGranularity(value as Granularity)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Clasificar" />
              </SelectTrigger>
              <SelectContent>
                {GRANULARITIES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sortOrder} onValueChange={(value) => { setSortOrder(value as SortOrder); setPage(1) }}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Orden" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="desc">Recientes</SelectItem>
                <SelectItem value="asc">Antiguos</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative sm:col-span-2 xl:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1) }}
                placeholder="Request id, usuario, ruta, mensaje..."
                className="min-w-0 pl-9"
              />
            </div>
          </div>

          {timePreset === "custom" ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="datetime-local" value={customFrom} onChange={(event) => { setCustomFrom(event.target.value); setPage(1) }} />
              <Input type="datetime-local" value={customTo} onChange={(event) => { setCustomTo(event.target.value); setPage(1) }} />
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
          ) : null}

          <div className="grid gap-2 md:grid-cols-3">
            {buckets.length === 0 ? (
              <div className="rounded-md border p-3 text-sm text-muted-foreground md:col-span-3">
                {loading ? "Cargando clasificación temporal..." : "Sin eventos en el rango seleccionado."}
              </div>
            ) : buckets.slice(0, 6).map((bucket) => (
              <button
                key={bucket.label}
                type="button"
                onClick={() => copyText(bucket.rows.map(triageLine).join("\n"), bucket.label)}
                className="min-w-0 rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="truncate text-sm font-medium">{bucket.label}</div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{bucket.rows.length} eventos</span>
                  <span>{bucket.errors} críticos</span>
                  <span>{bucket.warnings} advertencias</span>
                </div>
              </button>
            ))}
          </div>

          <div className="space-y-2 md:hidden">
            {rows.length === 0 ? (
              <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
                {loading ? "Cargando logs..." : "Sin logs para este filtro."}
              </div>
            ) : rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected(row)}
                className="w-full min-w-0 rounded-md border p-3 text-left"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{row.action}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{getRequestId(row) || row.resourceType || "sin request id"}</div>
                  </div>
                  {severityBadge(row)}
                </div>
                <div className="mt-3 text-sm text-muted-foreground">{compactMetadata(row.metadata)}</div>
                <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">{formatDate(row.createdAt)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2"
                    onClick={(event) => {
                      event.stopPropagation()
                      copyText(isoDate(row.createdAt), "Fecha")
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </button>
            ))}
          </div>

          <div className="hidden max-w-full overflow-x-auto rounded-md border md:block">
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Severidad</TableHead>
                  <TableHead>Evento</TableHead>
                  <TableHead>Contexto</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Fecha</TableHead>
                  <TableHead className="text-right">Copiar</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      {loading ? "Cargando logs..." : "Sin logs para este filtro."}
                    </TableCell>
                  </TableRow>
                ) : rows.map((row) => (
                  <TableRow key={row.id} className="cursor-pointer" onClick={() => setSelected(row)}>
                    <TableCell>{severityBadge(row)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{row.action}</div>
                      <div className="text-xs text-muted-foreground">{row.resourceType || "-"}</div>
                    </TableCell>
                    <TableCell className="max-w-[460px]">
                      <div className="truncate text-sm">{compactMetadata(row.metadata)}</div>
                      {getEndpoint(row) ? <div className="truncate font-mono text-xs text-muted-foreground">{getEndpoint(row)}</div> : null}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{row.actorId || "anon"}</div>
                      {row.actorName ? <div className="text-xs text-muted-foreground">{row.actorName}</div> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      <div>{formatDate(row.createdAt)}</div>
                      <div className="font-mono text-[11px]">{bucketLabel(row.createdAt, granularity)}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          copyText(triageLine(row), "Log")
                        }}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {total} eventos · página {page} de {pages}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => load(page - 1)}>
                Anterior
              </Button>
              <Button variant="outline" size="sm" disabled={loading || page >= pages} onClick={() => load(page + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {selected ? (
        <Card className="min-w-0 overflow-hidden border-primary/30">
          <CardHeader className="px-3 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  Detalle del log
                </CardTitle>
                <CardDescription className="mt-1 truncate font-mono">{selected.id}</CardDescription>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex">
                <Button variant="outline" size="sm" className="gap-2" onClick={() => copyText(triageLine(selected), "Resumen")}>
                  <Copy className="h-4 w-4" />
                  Resumen
                </Button>
                <Button variant="outline" size="sm" className="gap-2" onClick={() => copyText(toJson([selected]), "JSON")}>
                  <FileJson className="h-4 w-4" />
                  JSON
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 px-3 sm:px-6">
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Fecha</div>
                <div className="mt-1 font-medium">{formatDate(selected.createdAt)}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Request id</div>
                <div className="mt-1 truncate font-mono text-xs">{getRequestId(selected) || "-"}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Usuario</div>
                <div className="mt-1 truncate">{selected.actorName || selected.actorId || "anon"}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Ruta</div>
                <div className="mt-1 truncate font-mono text-xs">{getEndpoint(selected) || selected.resourceType || "-"}</div>
              </div>
            </div>
            <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
