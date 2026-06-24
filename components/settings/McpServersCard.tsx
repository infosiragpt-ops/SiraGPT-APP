"use client"

/**
 * McpServersCard — registra servidores MCP (Model Context Protocol) externos
 * para el agente del chat. Las herramientas de cada servidor se descubren al
 * inicio de cada turno agéntico y aparecen como `mcp__<servidor>__<tool>` con
 * permiso 'confirm' (el chat muestra la tarjeta Permitir / Permitir siempre /
 * Denegar antes de cada ejecución).
 *
 * Seguridad: los headers de autenticación se cifran en el backend
 * (AES-256) y la API NUNCA los devuelve — la lista solo indica si existen
 * (`hasHeaders`). Editar un servidor sin tocar los headers los conserva.
 *
 * Mismo patrón autocontenido que MemorySettingsCard (Card + apiClient +
 * toasts; los strings van en español como el resto de la página de ajustes).
 */

import React from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Plug, Plus, Trash2, KeyRound, X } from "lucide-react"
import { toast } from "sonner"
import { apiClient, type McpServerInfo } from "@/lib/api"

type HeaderRow = { key: string; value: string }

function apiErrorMessage(err: any, fallback: string): string {
  return err?.errorData?.error || err?.message || fallback
}

export function McpServersCard() {
  const [servers, setServers] = React.useState<McpServerInfo[]>([])
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [showForm, setShowForm] = React.useState(false)
  const [name, setName] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [transport, setTransport] = React.useState<"streamable-http" | "sse">("streamable-http")
  const [headerRows, setHeaderRows] = React.useState<HeaderRow[]>([])

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiClient.listMcpServers()
      setServers(Array.isArray(data.servers) ? data.servers : [])
    } catch {
      setServers([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const resetForm = () => {
    setName("")
    setUrl("")
    setTransport("streamable-http")
    setHeaderRows([])
    setShowForm(false)
  }

  const add = async () => {
    if (!name.trim() || !url.trim()) {
      toast.error("Nombre y URL son obligatorios")
      return
    }
    const headers: Record<string, string> = {}
    for (const row of headerRows) {
      if (row.key.trim()) headers[row.key.trim()] = row.value
    }
    setBusy(true)
    try {
      await apiClient.createMcpServer({
        name: name.trim(),
        url: url.trim(),
        transport,
        ...(Object.keys(headers).length ? { headers } : {}),
      })
      toast.success("Servidor MCP registrado", {
        description: "Sus herramientas se descubrirán en tu próximo mensaje del chat.",
      })
      resetForm()
      await load()
    } catch (err: any) {
      toast.error(apiErrorMessage(err, "No se pudo registrar el servidor"))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (server: McpServerInfo, enabled: boolean) => {
    // Optimistic flip; revert on failure.
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)))
    try {
      await apiClient.updateMcpServer(server.id, { enabled })
    } catch (err: any) {
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled: server.enabled } : s)))
      toast.error(apiErrorMessage(err, "No se pudo actualizar el servidor"))
    }
  }

  const remove = async (server: McpServerInfo) => {
    setBusy(true)
    try {
      await apiClient.deleteMcpServer(server.id)
      toast.success(`Servidor "${server.name}" eliminado`)
      await load()
    } catch (err: any) {
      toast.error(apiErrorMessage(err, "No se pudo eliminar el servidor"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-9 w-9 rounded-md bg-muted grid place-items-center shrink-0">
            <Plug className="h-4.5 w-4.5 text-foreground/70" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Servidores MCP</div>
            <div className="text-xs text-muted-foreground">
              Conecta servidores Model Context Protocol externos. Sus herramientas se suman al agente
              del chat y siempre piden tu permiso antes de ejecutarse.
            </div>
          </div>
        </div>
        {!showForm && (
          <Button size="sm" className="gap-1.5 shrink-0" onClick={() => setShowForm(true)}>
            <Plus className="h-3.5 w-3.5" />
            Añadir
          </Button>
        )}
      </div>

      {showForm && (
        <div className="mx-5 mb-4 space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Nombre</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. deepwiki" maxLength={48} />
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Transporte</div>
              <Select value={transport} onValueChange={(v) => setTransport(v as "streamable-http" | "sse")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">Streamable HTTP (recomendado)</SelectItem>
                  <SelectItem value="sse">SSE (legado)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">URL del servidor</div>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.ejemplo.com/mcp" inputMode="url" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs text-muted-foreground">Headers de autenticación (opcional)</div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs gap-1"
                onClick={() => setHeaderRows((rows) => [...rows, { key: "", value: "" }])}
              >
                <Plus className="h-3 w-3" />
                Header
              </Button>
            </div>
            {headerRows.length === 0 ? (
              <div className="text-xs text-muted-foreground/70">
                Sin headers. Se cifran al guardarse y no vuelven a mostrarse.
              </div>
            ) : (
              <div className="space-y-2">
                {headerRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={row.key}
                      onChange={(e) => setHeaderRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                      placeholder="Authorization"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={row.value}
                      onChange={(e) => setHeaderRows((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                      placeholder="Bearer …"
                      type="password"
                      className="h-8 text-xs"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => setHeaderRows((rows) => rows.filter((_, j) => j !== i))}
                      aria-label="Quitar header"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={add} disabled={busy}>Registrar servidor</Button>
            <Button size="sm" variant="ghost" onClick={resetForm} disabled={busy}>Cancelar</Button>
          </div>
        </div>
      )}

      <div className="border-t border-border/60">
        {loading ? (
          <div className="p-5 text-sm text-muted-foreground">Cargando servidores…</div>
        ) : servers.length === 0 ? (
          <div className="p-5 text-sm text-muted-foreground">
            No tienes servidores MCP registrados. Añade uno (por ejemplo{" "}
            <code className="px-1 py-0.5 rounded bg-muted text-foreground text-xs">https://mcp.deepwiki.com/mcp</code>)
            y el agente podrá usar sus herramientas.
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {servers.map((server) => (
              <div key={server.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{server.name}</span>
                    <Badge variant="secondary" className="text-[10px] font-mono shrink-0">
                      {server.transport === "sse" ? "SSE" : "HTTP"}
                    </Badge>
                    {server.hasHeaders && (
                      <Badge variant="secondary" className="gap-1 text-[10px] shrink-0">
                        <KeyRound className="h-2.5 w-2.5" />
                        credenciales
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">{server.url}</div>
                  <div className="text-[11px] text-muted-foreground/70 truncate">
                    Herramientas: <code className="font-mono">mcp__{server.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}__…</code>
                  </div>
                </div>
                <Switch
                  checked={server.enabled}
                  onCheckedChange={(v) => toggleEnabled(server, v)}
                  aria-label={`Activar ${server.name}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                  onClick={() => remove(server)}
                  disabled={busy}
                  aria-label={`Eliminar ${server.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}
