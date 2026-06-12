"use client"

/**
 * Admin · Logs — auditoría operativa del sistema.
 *
 * The sidebar has linked /admin/logs since the panel shipped, but the page
 * never existed (the entry dead-ended on the Next 404). The backend
 * (/api/admin/audit-logs[.csv|/search]) and the apiClient methods were
 * already implemented and consumer-less — this page is the missing consumer.
 */

import { useCallback, useEffect, useState } from "react"
import { Download, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { apiClient } from "@/lib/api"
import { toast } from "sonner"

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

function actionBadgeVariant(action: string): "default" | "secondary" | "destructive" | "outline" {
  if (/fail|error|denied|revoked|deleted/i.test(action)) return "destructive"
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

  const load = useCallback(async (targetPage: number, search: string, action: string) => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, string | number> = {
        page: targetPage,
        limit: PAGE_SIZE,
        order: "desc",
      }
      if (action && action !== "all") params.action = action
      const response: any = search.trim()
        ? await apiClient.searchAdminAuditLogs({ q: search.trim(), page: targetPage, limit: PAGE_SIZE, order: "desc" })
        : await apiClient.getAdminAuditLogs(params as any)
      const items: AuditLogRow[] = response?.items || response?.logs || []
      setRows(items)
      setHasMore(items.length >= PAGE_SIZE)
      setKnownActions((prev) => {
        const next = new Set(prev)
        items.forEach((row) => row.action && next.add(row.action))
        return Array.from(next).sort()
      })
    } catch (err: any) {
      setError(err?.message || "No se pudieron cargar los logs")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(page, searchTerm, actionFilter)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, actionFilter])

  const handleSearch = () => {
    setPage(1)
    void load(1, searchTerm, actionFilter)
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const params: Record<string, string> = {}
      if (actionFilter && actionFilter !== "all") params.action = actionFilter
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
              <CardDescription>Eventos más recientes primero</CardDescription>
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
              <Button variant="outline" size="sm" onClick={() => void load(page, searchTerm, actionFilter)} disabled={loading}>
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                Actualizar
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleExport()} disabled={exporting}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {exporting ? "Exportando…" : "Exportar CSV"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-6 text-center text-sm text-destructive">
              {error}
            </div>
          ) : rows.length === 0 && !loading ? (
            <div className="rounded-md border border-border/60 px-4 py-10 text-center text-sm text-muted-foreground">
              Sin eventos para este filtro.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Fecha</TableHead>
                  <TableHead className="w-48">Acción</TableHead>
                  <TableHead className="w-40">Actor</TableHead>
                  <TableHead className="w-36">Recurso</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
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
                    <TableCell className="max-w-md truncate text-xs text-muted-foreground" title={metadataSummary(row.metadata)}>
                      {metadataSummary(row.metadata) || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Página {page}</span>
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
    </div>
  )
}
