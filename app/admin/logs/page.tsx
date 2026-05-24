"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw, Search, ShieldAlert, TerminalSquare } from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiClient } from "@/lib/api"
import { cn } from "@/lib/utils"

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
  { value: "observability", label: "Errores de usuarios" },
  { value: "client-error", label: "Frontend" },
  { value: "api-error", label: "API" },
  { value: "server-error", label: "Servidor" },
  { value: "user-facing-error", label: "4xx visibles" },
  { value: "security", label: "Seguridad" },
  { value: "all", label: "Todo" },
]

function formatDate(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return date.toLocaleString()
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

function compactMetadata(metadata: AuditRow["metadata"]): string {
  if (!metadata) return "Sin metadata"
  const message = metadata.message || metadata.reason || metadata.error || metadata.status || null
  const endpoint = metadata.endpoint || metadata.page || metadata.path || null
  const requestId = metadata.requestId || metadata.request_id || null
  return [message, endpoint, requestId ? `req:${requestId}` : null].filter(Boolean).join(" · ") || "Metadata registrada"
}

export default function AdminLogsPage() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(1)
  const [filter, setFilter] = useState("observability")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AuditRow | null>(null)

  const load = useCallback(async (nextPage = page) => {
    setLoading(true)
    setError(null)
    try {
      const trimmed = search.trim()
      const result = trimmed.length >= 2
        ? await apiClient.searchAdminAuditLogs({ q: trimmed, page: nextPage, limit: 50 })
        : await apiClient.getAdminAuditLogs({
            page: nextPage,
            limit: 50,
            tags: filter === "all" ? undefined : filter,
          })
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
  }, [filter, page, search])

  useEffect(() => {
    const id = setTimeout(() => load(1), 250)
    return () => clearTimeout(id)
  }, [filter, search, load])

  const stats = useMemo(() => {
    const errors = rows.filter((row) => rowSeverity(row) === "error").length
    const warnings = rows.filter((row) => rowSeverity(row) === "warn").length
    const api = rows.filter((row) => row.metadata?.source === "api" || row.action.includes("api")).length
    return { errors, warnings, api, total: rows.length }
  }, [rows])

  return (
    <div className="flex-1 space-y-4 sm:space-y-6 p-3 sm:p-4 lg:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <SidebarTrigger className="md:hidden" />
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Logs</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Rastreo profesional de errores por usuario, acción, ruta y request id.
              </p>
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(page)} disabled={loading} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Recargar
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Eventos visibles</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><TerminalSquare className="h-5 w-5 text-sky-500" />{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Errores críticos</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><ShieldAlert className="h-5 w-5 text-red-500" />{stats.errors}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Advertencias</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><AlertTriangle className="h-5 w-5 text-amber-500" />{stats.warnings}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Fallos API</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><Clock3 className="h-5 w-5 text-violet-500" />{stats.api}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Investigación</CardTitle>
          <CardDescription>
            Busca por email, request id, ruta, acción o mensaje. Los valores sensibles se redactan antes de guardarse.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 md:grid-cols-[220px_1fr]">
            <Select value={filter} onValueChange={(value) => { setFilter(value); setPage(1) }}>
              <SelectTrigger>
                <SelectValue placeholder="Tipo de log" />
              </SelectTrigger>
              <SelectContent>
                {FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1) }}
                placeholder="Buscar request id, usuario, ruta, mensaje..."
                className="pl-9"
              />
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>
          ) : null}

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severidad</TableHead>
                  <TableHead>Evento</TableHead>
                  <TableHead>Contexto</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Fecha</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      {loading ? "Cargando logs..." : "Sin logs para este filtro."}
                    </TableCell>
                  </TableRow>
                ) : rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <TableCell>{severityBadge(row)}</TableCell>
                    <TableCell>
                      <div className="font-medium">{row.action}</div>
                      <div className="text-xs text-muted-foreground">{row.resourceType || "—"}</div>
                    </TableCell>
                    <TableCell className="max-w-[460px]">
                      <div className="truncate text-sm">{compactMetadata(row.metadata)}</div>
                      {row.metadata?.endpoint ? <div className="truncate font-mono text-xs text-muted-foreground">{row.metadata.endpoint}</div> : null}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-xs">{row.actorId || "anon"}</div>
                      {row.actorName ? <div className="text-xs text-muted-foreground">{row.actorName}</div> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatDate(row.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {total} eventos · página {page} de {pages}
            </div>
            <div className="flex gap-2">
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
        <Card className="border-primary/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Detalle del log
            </CardTitle>
            <CardDescription className="font-mono">{selected.id}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
