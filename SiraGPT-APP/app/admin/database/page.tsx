"use client"

/**
 * Admin · Base de datos — estado real de la base y su almacenamiento.
 *
 * This page used to render 100% invented data (hardcoded table counts,
 * fake health metrics, a setTimeout "backup" button and a fictional
 * backups list). It now consumes the real admin endpoints:
 *   - GET /api/admin/stats            → real prisma counts + storage
 *   - GET /api/admin/health/services  → live postgres/redis/queue probes
 *   - GET /api/admin/backups          → nightly pg_dump status (honest
 *     empty state when the script has never run)
 * The fake "Backup" button was removed on purpose: backups are produced
 * by scripts/backup-db.sh (cron), and there is no on-demand endpoint.
 */

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { apiClient } from "@/lib/api"
import { authenticatedFetch } from "@/lib/authenticated-fetch"

type ServiceProbe = {
  status?: string
  latency_ms?: number
  detail?: string
}

type AdminStats = {
  database?: Record<string, number>
  storage?: { totalFiles?: number; totalSize?: number }
}

type BackupInfo = {
  ok?: boolean
  lastBackupAt?: string | null
  sizeMB?: number | null
  retained?: number | null
  retentionDays?: number | null
}

const TABLE_LABELS: Array<{ key: string; label: string }> = [
  { key: "users", label: "Usuarios" },
  { key: "chats", label: "Chats" },
  { key: "messages", label: "Mensajes" },
  { key: "files", label: "Archivos" },
  { key: "payments", label: "Pagos" },
  { key: "apiUsage", label: "Uso de API" },
  { key: "sessions", label: "Sesiones" },
  { key: "auditLogs", label: "Logs de auditoría" },
]

function formatBytes(bytes: number | undefined | null): string {
  if (!Number.isFinite(bytes as number) || (bytes as number) <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes as number
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function probeBadge(probe?: ServiceProbe) {
  const status = (probe?.status || "").toLowerCase()
  if (status === "up" || status === "ok" || status === "healthy") {
    return <Badge className="bg-emerald-600 hover:bg-emerald-600">activo</Badge>
  }
  if (!status) return <Badge variant="outline">sin datos</Badge>
  return <Badge variant="destructive">{status}</Badge>
}

export default function DatabasePage() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [services, setServices] = useState<Record<string, ServiceProbe>>({})
  const [overall, setOverall] = useState<string>("")
  const [backups, setBackups] = useState<BackupInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsRes, healthRes, backupsRes] = await Promise.allSettled([
        apiClient.getSystemStats(),
        fetchJson("/api/admin/health/services"),
        fetchJson("/api/admin/backups"),
      ])
      if (statsRes.status === "fulfilled") setStats(statsRes.value as AdminStats)
      if (healthRes.status === "fulfilled") {
        const payload = healthRes.value as { overall?: string; services?: Record<string, ServiceProbe> }
        setOverall(payload?.overall || "")
        setServices(payload?.services || {})
      }
      if (backupsRes.status === "fulfilled") setBackups(backupsRes.value as BackupInfo)
      if (statsRes.status === "rejected" && healthRes.status === "rejected") {
        setError("No se pudieron cargar los datos de la base")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const db = stats?.database || {}
  const dbProbe = services.postgres
  const redisProbe = services.redis
  const queueProbe = services.bullmq

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Base de datos</h1>
          <p className="text-muted-foreground">Estado real de la base, almacenamiento y backups</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refrescar
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Salud en vivo — sondas reales del backend */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">PostgreSQL</CardTitle>
            {probeBadge(dbProbe)}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {Number.isFinite(dbProbe?.latency_ms) ? `${dbProbe?.latency_ms} ms` : "—"}
            </div>
            <p className="text-xs text-muted-foreground">latencia de sonda</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Redis</CardTitle>
            {probeBadge(redisProbe)}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {Number.isFinite(redisProbe?.latency_ms) ? `${redisProbe?.latency_ms} ms` : "—"}
            </div>
            <p className="text-xs text-muted-foreground">latencia de sonda</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Cola (BullMQ)</CardTitle>
            {probeBadge(queueProbe)}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {Number.isFinite(queueProbe?.latency_ms) ? `${queueProbe?.latency_ms} ms` : "—"}
            </div>
            <p className="text-xs text-muted-foreground">workers de tareas</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Estado general</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold capitalize">{overall || "—"}</div>
            <p className="text-xs text-muted-foreground">todas las sondas</p>
          </CardContent>
        </Card>
      </div>

      {/* Tablas — conteos reales de Prisma */}
      <Card>
        <CardHeader>
          <CardTitle>Tablas</CardTitle>
          <CardDescription>Registros reales por tabla principal</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tabla</TableHead>
                  <TableHead className="text-right">Registros</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TABLE_LABELS.map(({ key, label }) => (
                  <TableRow key={key}>
                    <TableCell className="font-medium">{label}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number.isFinite(db[key]) ? db[key].toLocaleString("es") : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Almacenamiento real (archivos subidos) */}
        <Card>
          <CardHeader>
            <CardTitle>Almacenamiento</CardTitle>
            <CardDescription>Archivos subidos por los usuarios</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span>Archivos totales</span>
              <span className="font-medium tabular-nums">{(stats?.storage?.totalFiles ?? 0).toLocaleString("es")}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>Tamaño total</span>
              <span className="font-medium tabular-nums">{formatBytes(stats?.storage?.totalSize)}</span>
            </div>
          </CardContent>
        </Card>

        {/* Backups — estado del pg_dump nocturno */}
        <Card>
          <CardHeader>
            <CardTitle>Backups</CardTitle>
            <CardDescription>pg_dump nocturno (scripts/backup-db.sh)</CardDescription>
          </CardHeader>
          <CardContent>
            {backups?.lastBackupAt ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span>Último backup</span>
                  <span className="font-medium">{new Date(backups.lastBackupAt).toLocaleString("es")}</span>
                </div>
                {Number.isFinite(backups.sizeMB as number) && (
                  <div className="flex items-center justify-between text-sm">
                    <span>Tamaño</span>
                    <span className="font-medium tabular-nums">{backups.sizeMB} MB</span>
                  </div>
                )}
                {Number.isFinite(backups.retained as number) && (
                  <div className="flex items-center justify-between text-sm">
                    <span>Copias retenidas</span>
                    <span className="font-medium tabular-nums">
                      {backups.retained}{backups.retentionDays ? ` (${backups.retentionDays} días)` : ""}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Sin backups registrados todavía. El script nocturno escribe aquí su último estado al ejecutarse.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// Minimal authenticated JSON fetch against the same-origin API proxy.
async function fetchJson(path: string): Promise<unknown> {
  const res = await authenticatedFetch(path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
