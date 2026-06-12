"use client"

/**
 * Admin · Seguridad — estado real del Security Center.
 *
 * Reemplaza la versión 100% mockeada (eventos inventados, score 85/100
 * hardcodeado y una tarjeta de "Master API Key" ficticia — eliminada a
 * propósito: el material de claves jamás debe renderizarse). Consume
 * GET/PUT /api/admin/security.
 */

import { useCallback, useEffect, useState } from "react"
import { Shield, Key, XCircle, Eye, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

type SecurityOverview = {
  securityScore?: number
  activeSessions?: number
  apiKeys?: number
  twoFactorUsers?: number
  emailVerifiedUsers?: number
  failedLogins24h?: number
}

type SecurityEvent = {
  id: string
  action: string
  actor?: string | null
  ip?: string | null
  createdAt: string
  severity: "high" | "medium" | "low"
}

type SecuritySettings = {
  require2faForAdmins: boolean
  sessionTimeoutMinutes: number
  passwordMinLength: number
  ipAllowlistEnabled: boolean
  apiRateLimitEnabled: boolean
}

async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("auth-token") : null
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
    credentials: "include",
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const severityVariant = (severity: string) =>
  severity === "high" ? "destructive" : severity === "medium" ? "secondary" : "outline"

export default function SecurityPage() {
  const [overview, setOverview] = useState<SecurityOverview>({})
  const [events, setEvents] = useState<SecurityEvent[]>([])
  const [settings, setSettings] = useState<SecuritySettings | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchJson("/api/admin/security")
      setOverview(data.overview || {})
      setEvents(data.events || [])
      setSettings(data.settings || null)
    } catch {
      setError("No se pudo cargar el estado de seguridad")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (next: SecuritySettings) => {
    setSettings(next) // optimista
    setSaving(true)
    try {
      const data = await fetchJson("/api/admin/security/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      })
      setSettings(data.settings)
      toast.success("Ajustes de seguridad guardados")
      void load()
    } catch {
      toast.error("No se pudieron guardar los ajustes")
      void load()
    } finally {
      setSaving(false)
    }
  }

  const score = overview.securityScore ?? null

  return (
    <div className="flex-1 space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Seguridad</h1>
          <p className="text-muted-foreground">Postura real del sistema, eventos y políticas</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refrescar
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {/* Resumen — todo medido en vivo */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Puntuación</CardTitle>
            <Shield className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${score !== null && score >= 70 ? "text-green-600" : score !== null && score >= 40 ? "text-amber-600" : "text-red-600"}`}>
              {score !== null ? `${score}/100` : "—"}
            </div>
            <p className="text-xs text-muted-foreground">heurística ponderada (2FA, verificación, intentos fallidos, políticas)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Sesiones activas</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{overview.activeSessions ?? "—"}</div>
            <p className="text-xs text-muted-foreground">con expiración vigente</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Logins fallidos</CardTitle>
            <XCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold tabular-nums ${(overview.failedLogins24h ?? 0) > 0 ? "text-red-600" : ""}`}>
              {overview.failedLogins24h ?? "—"}
            </div>
            <p className="text-xs text-muted-foreground">últimas 24 horas</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">API Keys</CardTitle>
            <Key className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{overview.apiKeys ?? "—"}</div>
            <p className="text-xs text-muted-foreground">claves de usuario registradas</p>
          </CardContent>
        </Card>
      </div>

      {/* Políticas persistidas */}
      <Card>
        <CardHeader>
          <CardTitle>Políticas de seguridad</CardTitle>
          <CardDescription>Se guardan en el servidor (system_settings) y quedan auditadas</CardDescription>
        </CardHeader>
        <CardContent>
          {!settings ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{loading ? "Cargando…" : "Sin datos"}</p>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">2FA obligatorio para administradores</div>
                  <div className="text-xs text-muted-foreground">Exige autenticación en dos pasos en cuentas admin</div>
                </div>
                <Switch
                  checked={settings.require2faForAdmins}
                  disabled={saving}
                  onCheckedChange={(v) => void save({ ...settings, require2faForAdmins: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Allowlist de IPs</div>
                  <div className="text-xs text-muted-foreground">Restringe el panel a IPs aprobadas</div>
                </div>
                <Switch
                  checked={settings.ipAllowlistEnabled}
                  disabled={saving}
                  onCheckedChange={(v) => void save({ ...settings, ipAllowlistEnabled: v })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Rate limiting de API</div>
                  <div className="text-xs text-muted-foreground">Limita solicitudes por usuario</div>
                </div>
                <Switch
                  checked={settings.apiRateLimitEnabled}
                  disabled={saving}
                  onCheckedChange={(v) => void save({ ...settings, apiRateLimitEnabled: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Timeout de sesión (minutos)</div>
                  <div className="text-xs text-muted-foreground">Entre 15 y 10.080 (7 días)</div>
                </div>
                <Input
                  type="number"
                  className="w-28 text-right tabular-nums"
                  value={settings.sessionTimeoutMinutes}
                  min={15}
                  max={10080}
                  disabled={saving}
                  onChange={(e) => setSettings({ ...settings, sessionTimeoutMinutes: Number(e.target.value) })}
                  onBlur={() => void save(settings)}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Longitud mínima de contraseña</div>
                  <div className="text-xs text-muted-foreground">Entre 6 y 128 caracteres</div>
                </div>
                <Input
                  type="number"
                  className="w-28 text-right tabular-nums"
                  value={settings.passwordMinLength}
                  min={6}
                  max={128}
                  disabled={saving}
                  onChange={(e) => setSettings({ ...settings, passwordMinLength: Number(e.target.value) })}
                  onBlur={() => void save(settings)}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Eventos reales de auditoría */}
      <Card>
        <CardHeader>
          <CardTitle>Eventos de seguridad recientes</CardTitle>
          <CardDescription>Desde el registro de auditoría del sistema</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {loading ? "Cargando…" : "Sin eventos de seguridad registrados."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Evento</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>IP</TableHead>
                    <TableHead>Fecha</TableHead>
                    <TableHead>Severidad</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-mono text-xs">{event.action}</TableCell>
                      <TableCell className="max-w-44 truncate text-xs">{event.actor || "—"}</TableCell>
                      <TableCell className="text-xs tabular-nums">{event.ip || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(event.createdAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
                      </TableCell>
                      <TableCell>
                        <Badge variant={severityVariant(event.severity)}>{event.severity}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
